use itertools::Itertools;
use std::collections::HashMap;
use std::hash::Hash;
use std::ops::Index;

#[derive(Debug, Clone)]
pub(crate) struct IndexedCache<T> {
    pub(crate) cache: Vec<T>,
    pub(crate) lookup: HashMap<T, usize>,
}

impl<T> PartialEq for IndexedCache<T>
where
    T: PartialEq,
{
    fn eq(&self, other: &Self) -> bool {
        self.cache == other.cache
    }
}

impl<T> IndexedCache<T>
where
    T: Clone + Eq + Hash + Ord,
{
    pub(crate) fn new() -> Self {
        IndexedCache {
            cache: Default::default(),
            lookup: Default::default(),
        }
    }

    pub(crate) fn cache(&mut self, item: T) -> usize {
        if let Some(n) = self.lookup.get(&item) {
            *n
        } else {
            let n = self.cache.len();
            self.cache.push(item.clone());
            self.lookup.insert(item, n);
            n
        }
    }

    pub(crate) fn lookup(&self, item: &T) -> Option<usize> {
        self.lookup.get(item).cloned()
    }

    #[allow(dead_code)]
    pub(crate) fn len(&self) -> usize {
        self.cache.len()
    }

    // Temporairly override `get` to unwrap safe get
    pub(crate) fn get(&self, index: usize) -> &T {
        &self.cache[index]
    }

    // Temporairly override `safe_get` to use the first if we have an off-by-one error
    // in this case we can't trust any of the actor IDs but it should still not fail.
    pub(crate) fn safe_get(&self, index: usize) -> Option<&T> {
        self.cache.get(index)
    }

    #[allow(dead_code)]
    pub(crate) fn sorted(&self) -> IndexedCache<T> {
        let mut sorted = Self::new();
        self.cache.iter().sorted().cloned().for_each(|item| {
            let n = sorted.cache.len();
            sorted.cache.push(item.clone());
            sorted.lookup.insert(item, n);
        });
        sorted
    }
}

impl<T> IntoIterator for IndexedCache<T> {
    type Item = T;
    type IntoIter = std::vec::IntoIter<Self::Item>;

    fn into_iter(self) -> Self::IntoIter {
        self.cache.into_iter()
    }
}

impl<T> Index<usize> for IndexedCache<T> {
    type Output = T;
    fn index(&self, i: usize) -> &T {
        &self.cache[i]
    }
}

impl<A: Hash + Eq + Clone> FromIterator<A> for IndexedCache<A> {
    fn from_iter<T: IntoIterator<Item = A>>(iter: T) -> Self {
        let mut cache = Vec::new();
        let mut lookup = HashMap::new();
        for (index, elem) in iter.into_iter().enumerate() {
            cache.push(elem.clone());
            lookup.insert(elem, index);
        }
        Self { cache, lookup }
    }
}
