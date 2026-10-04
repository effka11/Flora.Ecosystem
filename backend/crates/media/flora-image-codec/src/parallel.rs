//! Параллельная обработка независимых тайлов на чистом std.
//!
//! Feature `threads` (по умолчанию включена) распределяет элементы по
//! `std::thread::scope`-потокам непрерывными чанками; результат собирается
//! в исходном порядке, поэтому выход бит-в-бит не зависит от числа потоков.
//! Без фичи (например, wasm32 без атомиков) — последовательный путь.

/// Упорядоченный map по элементам, параллельный при наличии `threads`.
pub fn par_map<T, R, F>(items: &[T], f: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
{
    #[cfg(feature = "threads")]
    {
        let workers = std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(1)
            .min(items.len());
        if workers > 1 {
            let chunk = items.len().div_ceil(workers);
            let mut results: Vec<Option<R>> = Vec::with_capacity(items.len());
            results.resize_with(items.len(), || None);
            std::thread::scope(|scope| {
                for (in_chunk, out_chunk) in items.chunks(chunk).zip(results.chunks_mut(chunk)) {
                    scope.spawn(|| {
                        for (item, slot) in in_chunk.iter().zip(out_chunk.iter_mut()) {
                            *slot = Some(f(item));
                        }
                    });
                }
            });
            // Все слоты заполнены по построению: чанки покрывают весь срез.
            return results.into_iter().map(|r| r.expect("par_map: слот заполнен")).collect();
        }
    }
    items.iter().map(f).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_order_and_covers_all() {
        let items: Vec<usize> = (0..1000).collect();
        let out = par_map(&items, |&x| x * 2);
        assert_eq!(out, (0..1000).map(|x| x * 2).collect::<Vec<_>>());
    }

    #[test]
    fn empty_and_single() {
        assert_eq!(par_map(&[] as &[u32], |&x| x), Vec::<u32>::new());
        assert_eq!(par_map(&[7u32], |&x| x + 1), vec![8]);
    }
}
