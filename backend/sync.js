/**
 * Implementation of the data synchronisation protocol that brings a local and a remote document
 * into the same state. This is typically used when two nodes have been disconnected for some time,
 * and need to exchange any changes that happened while they were disconnected. The two nodes that
 * are syncing could be client and server, or server and client, or two peers with symmetric roles.
 *
 * The protocol is based on this paper: Martin Kleppmann and Heidi Howard. Byzantine Eventual
 * Consistency and the Fundamental Limits of Peer-to-Peer Databases. https://arxiv.org/abs/2012.00472
 *
 * The protocol assumes that every time a node successfully syncs with another node, it remembers
 * the current heads (as returned by `Backend.getHeads()`) after the last sync with that node. The
 * next time we try to sync with the same node, we start from the assumption that the other node's
 * document version is no older than the outcome of the last sync, so we only need to exchange any
 * changes that are more recent than the last sync. This assumption may not be true if the other
 * node did not correctly persist its state (perhaps it crashed before writing the result of the
 * last sync to disk), and we fall back to sending the entire document in this case.
 */

const { List } = require('immutable')
const { backendState } = require('./util')
const Backend = require('./backend')
const OpSet = require('./op_set')
const { hexStringToBytes, bytesToHexString, Encoder, Decoder } = require('./encoding')
const { decodeChangeMeta, getChangeChecksum } = require('./columnar')
const { equalBytes } = require('../src/common')

const HASH_SIZE = 32 // 256 bits = 32 bytes
const MESSAGE_TYPE_SYNC = 0x42 // first byte of a sync message, for identification
const PEER_STATE_TYPE = 0x43 // first byte of an encoded peer state, for identification

// These constants correspond to a 1% false positive rate. The values can be changed without
// breaking compatibility of the network protocol, since the parameters used for a particular
// Bloom filter are encoded in the wire format.
const BITS_PER_ENTRY = 10, NUM_PROBES = 7

/**
 * A Bloom filter implementation that can be serialised to a byte array for transmission
 * over a network. The entries that are added are assumed to already be SHA-256 hashes,
 * so this implementation does not perform its own hashing.
 */
class BloomFilter {
  constructor (arg) {
    if (Array.isArray(arg)) {
      // arg is an array of SHA256 hashes in hexadecimal encoding
      this.numEntries = arg.length
      this.numBitsPerEntry = BITS_PER_ENTRY
      this.numProbes = NUM_PROBES
      this.bits = new Uint8Array(Math.ceil(this.numEntries * this.numBitsPerEntry / 8))
      for (let hash of arg) this.addHash(hash)
    } else if (arg instanceof Uint8Array) {
      if (arg.byteLength === 0) {
        this.numEntries = 0
        this.numBitsPerEntry = 0
        this.numProbes = 0
        this.bits = arg
      } else {
        const decoder = new Decoder(arg)
        this.numEntries = decoder.readUint32()
        this.numBitsPerEntry = decoder.readUint32()
        this.numProbes = decoder.readUint32()
        this.bits = decoder.readRawBytes(Math.ceil(this.numEntries * this.numBitsPerEntry / 8))
      }
    } else {
      throw new TypeError('invalid argument')
    }
  }

  /**
   * Returns the Bloom filter state, encoded as a byte array.
   */
  get bytes() {
    if (this.numEntries === 0) return Uint8Array.of()
    const encoder = new Encoder()
    encoder.appendUint32(this.numEntries)
    encoder.appendUint32(this.numBitsPerEntry)
    encoder.appendUint32(this.numProbes)
    encoder.appendRawBytes(this.bits)
    return encoder.buffer
  }

  /**
   * Given a SHA-256 hash (as hex string), returns an array of probe indexes indicating which bits
   * in the Bloom filter need to be tested or set for this particular entry. We do this by
   * interpreting the first 12 bytes of the hash as three little-endian 32-bit unsigned integers,
   * and then using triple hashing to compute the probe indexes. The algorithm comes from:
   *
   * Peter C. Dillinger and Panagiotis Manolios. Bloom Filters in Probabilistic Verification.
   * 5th International Conference on Formal Methods in Computer-Aided Design (FMCAD), November 2004.
   * http://www.ccis.northeastern.edu/home/pete/pub/bloom-filters-verification.pdf
   */
  getProbes(hash) {
    const hashBytes = hexStringToBytes(hash), modulo = 8 * this.bits.byteLength
    if (hashBytes.byteLength !== 32) throw new RangeError(`Not a 256-bit hash: ${hash}`)
    // on the next three lines, the right shift means interpret value as unsigned
    let x = ((hashBytes[0] | hashBytes[1] << 8 | hashBytes[2]  << 16 | hashBytes[3]  << 24) >>> 0) % modulo
    let y = ((hashBytes[4] | hashBytes[5] << 8 | hashBytes[6]  << 16 | hashBytes[7]  << 24) >>> 0) % modulo
    let z = ((hashBytes[8] | hashBytes[9] << 8 | hashBytes[10] << 16 | hashBytes[11] << 24) >>> 0) % modulo
    const probes = [x]
    for (let i = 1; i < this.numProbes; i++) {
      x = (x + y) % modulo
      y = (y + z) % modulo
      probes.push(x)
    }
    return probes
  }

  /**
   * Sets the Bloom filter bits corresponding to a given SHA-256 hash (given as hex string).
   */
  addHash(hash) {
    for (let probe of this.getProbes(hash)) {
      this.bits[probe >>> 3] |= 1 << (probe & 7)
    }
  }

  /**
   * Tests whether a given SHA-256 hash (given as hex string) is contained in the Bloom filter.
   */
  containsHash(hash) {
    if (this.numEntries === 0) return false
    for (let probe of this.getProbes(hash)) {
      if ((this.bits[probe >>> 3] & (1 << (probe & 7))) === 0) {
        return false
      }
    }
    return true
  }
}

/**
 * Encodes a sorted array of SHA-256 hashes (as hexadecimal strings) into a byte array.
 */
function encodeHashes(encoder, hashes) {
  if (!Array.isArray(hashes)) throw new TypeError('hashes must be an array')
  encoder.appendUint32(hashes.length)
  for (let i = 0; i < hashes.length; i++) {
    if (i > 0 && hashes[i - 1] >= hashes[i]) throw new RangeError('hashes must be sorted')
    const bytes = hexStringToBytes(hashes[i])
    if (bytes.byteLength !== HASH_SIZE) throw new TypeError('heads hashes must be 256 bits')
    encoder.appendRawBytes(bytes)
  }
}

/**
 * Decodes a byte array in the format returned by encodeHashes(), and returns its content as an
 * array of hex strings.
 */
function decodeHashes(decoder) {
  let length = decoder.readUint32(), hashes = []
  for (let i = 0; i < length; i++) {
    hashes.push(bytesToHexString(decoder.readRawBytes(HASH_SIZE)))
  }
  return hashes
}

/**
 * Takes a sync message of the form `{heads, need, have}` and encodes it as a byte array for
 * transmission.
 */
function encodeSyncMessage(message) {
  const encoder = new Encoder()
  encoder.appendByte(MESSAGE_TYPE_SYNC)
  encodeHashes(encoder, message.heads)
  encodeHashes(encoder, message.need)
  encoder.appendUint32(message.have.length)
  for (let have of message.have) {
    encodeHashes(encoder, have.lastSync)
    encoder.appendPrefixedBytes(have.bloom)
  }
  const changes = message.changes || []
  encoder.appendUint32(message.changes.length)
  for (let change of message.changes) {
    encoder.appendPrefixedBytes(change)
  }
  return encoder.buffer
}

/**
 * Takes a binary-encoded sync message and decodes it into the form `{heads, need, have}`.
 */
function decodeSyncMessage(bytes) {
  const decoder = new Decoder(bytes)
  const messageType = decoder.readByte()
  if (messageType !== MESSAGE_TYPE_SYNC) {
    throw new RangeError(`Unexpected message type: ${messageType}`)
  }
  const heads = decodeHashes(decoder)
  const need = decodeHashes(decoder)
  const haveCount = decoder.readUint32()
  let message = {heads, need, have: [], changes: []}
  for (let i = 0; i < haveCount; i++) {
    const lastSync = decodeHashes(decoder)
    const bloom = decoder.readPrefixedBytes(decoder)
    message.have.push({lastSync, bloom})
  }
  const changeCount = decoder.readUint32()
  for (let i = 0; i < changeCount; i++) {
    const change = decoder.readPrefixedBytes()
    message.changes.push(change)
  }
  // Ignore any trailing bytes -- they can be used for extensions by future versions of the protocol
  return message
}

/**
 * Takes a SyncState and encodes as a byte array those parts of the state that should persist across
 * an application restart or disconnect and reconnect. The ephemeral parts of the state that should
 * be cleared on reconnect are not encoded.
 */
function encodeSyncState(syncState) {
  const encoder = new Encoder()
  encoder.appendByte(PEER_STATE_TYPE)
  encodeHashes(encoder, syncState.sharedHeads)
  return encoder.buffer
}

/**
 * Takes a persisted peer state as encoded by `encodeSyncState` and decodes it into a SyncState
 * object. The parts of the peer state that were not encoded are initialised with default values.
 */
function decodeSyncState(bytes) {
  const decoder = new Decoder(bytes)
  const recordType = decoder.readByte()
  if (recordType !== PEER_STATE_TYPE) {
    throw new RangeError(`Unexpected record type: ${recordType}`)
  }
  const sharedHeads = decodeHashes(decoder)
  // Ignore any trailing bytes -- they can be used for extensions by future versions
  // TODO: this duplicates emptySyncState() in protocol.js. Remove the duplication when we merge
  // the content of that file into this one.
  return {
    sharedHeads,
    lastSentHeads: [],
    theirHeads: null,
    theirNeed: null,
    ourNeed: [],
    have: [],
    unappliedChanges: [],
    sentChanges: []
  }
}

/**
 * Constructs a Bloom filter containing all changes that are not one of the hashes in
 * `lastSync` or its transitive dependencies. In other words, the filter contains those
 * changes that have been applied since the version identified by `lastSync`. Returns
 * an object of the form `{lastSync, bloom}` as required for the `have` field of a sync
 * message.
 */
function makeBloomFilter(backend, lastSync) {
  const newChanges = OpSet.getMissingChanges(backend.get('opSet'), List(lastSync))
  const hashes = newChanges.map(change => decodeChangeMeta(change, true).hash)
  return {lastSync, bloom: new BloomFilter(hashes).bytes}
}

/**
 * Call this function when a sync message is received from another node. The `message` argument
 * needs to already have been decoded using `decodeSyncMessage()`. This function determines the
 * changes that we need to send to the other node in response. Returns an array of changes (as
 * byte arrays).
 */
function getChangesToSend(backend, have, need) {
  const opSet = backend.get('opSet')
  if (have.length === 0) {
    return need.map(hash => OpSet.getChangeByHash(opSet, hash))
  }

  let lastSyncHashes = {}, bloomFilters = []
  for (let h of have) {
    for (let hash of h.lastSync) lastSyncHashes[hash] = true
    bloomFilters.push(new BloomFilter(h.bloom))
  }

  // Get all changes that were added since the last sync
  const changes = OpSet.getMissingChanges(opSet, List(Object.keys(lastSyncHashes)))
    .map(change => decodeChangeMeta(change, true))

  let changeHashes = {}, dependents = {}, hashesToSend = {}
  for (let change of changes) {
    changeHashes[change.hash] = true

    // For each change, make a list of changes that depend on it
    for (let dep of change.deps) {
      if (!dependents[dep]) dependents[dep] = []
      dependents[dep].push(change.hash)
    }

    // Exclude any change hashes contained in one or more Bloom filters
    if (bloomFilters.every(bloom => !bloom.containsHash(change.hash))) {
      hashesToSend[change.hash] = true
    }
  }

  // Include any changes that depend on a Bloom-negative change
  let stack = Object.keys(hashesToSend)
  while (stack.length > 0) {
    const hash = stack.pop()
    if (dependents[hash]) {
      for (let dep of dependents[hash]) {
        if (!hashesToSend[dep]) {
          hashesToSend[dep] = true
          stack.push(dep)
        }
      }
    }
  }

  // Include any explicitly requested changes
  let changesToSend = []
  for (let hash of need) {
    hashesToSend[hash] = true
    if (!changeHashes[hash]) { // Change is not among those returned by getMissingChanges()?
      const change = OpSet.getChangeByHash(opSet, hash)
      if (change) changesToSend.push(change)
    }
  }

  // Return changes in the order they were returned by getMissingChanges()
  for (let change of changes) {
    if (hashesToSend[change.hash]) changesToSend.push(change.change)
  }
  return changesToSend
}

function emptySyncState() {
  return {
    sharedHeads: [],
    lastSentHeads: [],
    theirHeads: null,
    theirNeed: null,
    ourNeed: [],
    have: [],
    unappliedChanges: [],
    sentChanges: []
  }
}

function compareArrays(a, b) {
    return (a.length === b.length) && a.every((v, i) => v === b[i])
}

/**
 * Takes two arrays of binary changes, `previousChanges` and `newChanges`. Returns those changes in
 * `newChanges` that do not appear in `previousChanges`.
 */
function deduplicateChanges(previousChanges, newChanges) {
  // To avoid an O(n^2) comparison of every change with every other change, we use the fact that
  // bytes 4 to 7 of every change are a 32-bit checksum that is uniformly distributed, i.e. two
  // different changes are likely to have different checksums. Thus, we first construct an index
  // from checksum to the indexes in `previousChanges` at which those checksums appear, and then we
  // can detect cheaply whether an entry in `newChanges` already exists in `previousChanges`.
  let index = new Map()
  for (let i = 0; i < previousChanges.length; i++) {
    const checksum = getChangeChecksum(previousChanges[i])
    if (!index.has(checksum)) index.set(checksum, [])
    index.get(checksum).push(i)
  }

  return newChanges.filter(change => {
    const positions = index.get(getChangeChecksum(change))
    if (!positions) return true
    return !positions.some(i => equalBytes(change, previousChanges[i]))
  })
}

/**
 * Given a backend and what we believe to be the state of our peer, generate a message which tells
 * them about we have and includes any changes we believe they need
 */
function generateSyncMessage(syncState, backend) {
  syncState = syncState || emptySyncState()

  const { sharedHeads, ourNeed, theirHeads, theirNeed, have: theirHave, unappliedChanges } = syncState
  const ourHeads = Backend.getHeads(backend)
  const state = backendState(backend)

  // There are two reasons why ourNeed may be nonempty: 1. we might be missing dependencies due to
  // Bloom filter false positives; 2. we might be missing heads that the other peer mentioned
  // because they (intentionally) only sent us a subset of changes. In case 1, we leave the `have`
  // field of the message empty because we just want to fill in the missing dependencies for now.
  // In case 2, or if ourNeed is empty, we send a Bloom filter to request any unsent changes.
  let have = []
  if (ourNeed.every(hash => theirHeads.includes(hash))) {
    have = [makeBloomFilter(state, sharedHeads)]
  }

  // Fall back to a full re-sync if the sender's last sync state includes hashes
  // that we don't know. This could happen if we crashed after the last sync and
  // failed to persist changes that the other node already sent us.
  if (theirHave.length > 0) {
    const lastSync = theirHave[0].lastSync
    if (!lastSync.every(hash => Backend.getChangeByHash(backend, hash))) {
      // we need to queue them to send us a fresh sync message, the one they sent is uninteligible so we don't know what they need
      const resetMsg = {heads: ourHeads, need: [], have: [{ lastSync: [], bloom: Uint8Array.of() }], changes: []}
      return [syncState, encodeSyncMessage(resetMsg)]
    }
  }

  // XXX: we should limit ourselves to only sending a subset of all the messages, probably limited by a total message size
  //      these changes should ideally be RLE encoded but we haven't implemented that yet.
  let changesToSend = Array.isArray(theirHave) && Array.isArray(theirNeed) ? getChangesToSend(state, theirHave, theirNeed) : []
  const heads = Backend.getHeads(backend)

  // If the heads are equal, we're in sync and don't need to do anything further
  const headsUnchanged = Array.isArray(syncState.lastSentHeads) && compareArrays(heads, syncState.lastSentHeads)
  const headsEqual = Array.isArray(theirHeads) && compareArrays(ourHeads, theirHeads)
  if (headsUnchanged && headsEqual && changesToSend.length === 0 && ourNeed.length === 0) {
    return [syncState, null]
    // no need to send a sync message if we know we're synced!
  }

  if (syncState.sentChanges.length > 0 && changesToSend.length > 0) {
    changesToSend = deduplicateChanges(syncState.sentChanges, changesToSend)
  }

  // Regular response to a sync message: send any changes that the other node
  // doesn't have. We leave the "have" field empty because the previous message
  // generated by `syncStart` already indicated what changes we have.
  const syncMessage = {heads, have, need: ourNeed, changes: changesToSend}
  syncState = {
    ...syncState,
    lastSentHeads: heads,
    sentChanges: syncState.sentChanges.concat(changesToSend)
  }
  return [syncState, encodeSyncMessage(syncMessage)]
}

/**
 * Computes the heads that we share with a peer after we have just received some changes from that
 * peer and applied them. This may not be sufficient to bring our heads in sync with the other
 * peer's heads, since they may have only sent us a subset of their outstanding changes.
 *
 * `myOldHeads` are the local heads before the most recent changes were applied, `myNewHeads` are
 * the local heads after those changes were applied, and `ourOldSharedHeads` is the previous set of
 * shared heads. Applying the changes will have replaced some heads with others, but some heads may
 * have remained unchanged (because they are for branches on which no changes have been added). Any
 * such unchanged heads remain in the sharedHeads. Any sharedHeads that were replaced by applying
 * changes are also replaced as sharedHeads. This is safe because if we received some changes from
 * another peer, that means that peer had those changes, and therefore we now both know about them.
 */
function advanceHeads(myOldHeads, myNewHeads, ourOldSharedHeads) {
  const newHeads = myNewHeads.filter((head) => !myOldHeads.includes(head))
  const commonHeads = ourOldSharedHeads.filter((head) => myNewHeads.includes(head))
  const advancedHeads = [...new Set([...newHeads, ...commonHeads])].sort()
  return advancedHeads
}


/**
 * Given a backend, a message message and the state of our peer, apply any changes, update what
 * we believe about the peer, and (if there were applied changes) produce a patch for the frontend
 */
function receiveSyncMessage(oldSyncState, backend, binaryMessage) {
  let patch = null
  oldSyncState = oldSyncState || emptySyncState()
  let { unappliedChanges, ourNeed, sharedHeads, lastSentHeads } = oldSyncState
  const message = decodeSyncMessage(binaryMessage)

  const { heads, changes } = message
  const beforeHeads = Backend.getHeads(backend)
  // when we receive a sync message, first we apply any changes they sent us
  if (changes.length > 0) {
    unappliedChanges = [...unappliedChanges, ...changes]
    ourNeed = Backend.getMissingDeps(backend, unappliedChanges, heads)

    // If there are no missing dependencies, we can apply the changes we received and update
    // sharedHeads to include the changes we applied. This does not necessarily mean we have
    // received all the changes necessar to bring us in sync with the remote peer's heads: the
    // set of changes in the message may be a prefix of the change log. If the only outstanding
    // needs are for heads, that implies there are no missing dependencies.
    if (ourNeed.every(hash => heads.includes(hash))) {
      ;[backend, patch] = Backend.applyChanges(backend, unappliedChanges)
      unappliedChanges = []
      sharedHeads = advanceHeads(beforeHeads, Backend.getHeads(backend), sharedHeads)
    }
  } else if (compareArrays(heads, beforeHeads)) {
    // If heads are equal, indicate we don't need to send a response message
    lastSentHeads = heads
  }

  // If all of the remote heads are known to us, that means either our heads are equal, or we are
  // ahead of the remote peer. In this case, take the remote heads to be our shared heads.
  const knownHeads = heads.filter(head => Backend.getChangeByHash(backend, head))
  if (knownHeads.length === heads.length) {
    sharedHeads = heads
  } else {
    // If some remote heads are unknown to us, we add all the remote heads we know to
    // sharedHeads, but don't remove anything from sharedHeads. This might cause sharedHeads to
    // contain some redundant hashes (where one hash is actually a transitive dependency of
    // another), but this will be cleared up as soon as we know all the remote heads.
    sharedHeads = [...new Set(knownHeads.concat(sharedHeads))].sort()
  }

  const newSyncState = {
    sharedHeads, // what we have in common to generate an efficient bloom filter
    lastSentHeads,
    have: message.have, // the information we need to calculate the changes they need
    theirHeads: message.heads,
    theirNeed: message.need,
    ourNeed, // specifically missing change (bloom filter false positives)
    unappliedChanges, // the changes we can't use yet because of the above
    sentChanges: oldSyncState.sentChanges
  }
  return [newSyncState, backend, patch]
}

module.exports = {
  receiveSyncMessage, generateSyncMessage,
  encodeSyncMessage, decodeSyncMessage,
  encodeSyncState, decodeSyncState,
  BloomFilter // BloomFilter is a private API, exported only for testing purposes
}
