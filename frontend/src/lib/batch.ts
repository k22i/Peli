// Many asks of one id, made in the same tick (the cards of a page as they
// mount), sent to Go as one call with every id (#128): one bridge call a
// page instead of one a card.

// The most ids one call carries; more go in several calls.
export const batchSize = 200;

export function batcher<V>(call: (ids: string[]) => Promise<V[]>): (id: string) => Promise<V> {
  let queue = new Map<
    string,
    { resolve: (value: V) => void; reject: (error: unknown) => void }[]
  >();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const asked = queue;
    queue = new Map();
    const ids = [...asked.keys()];
    for (let start = 0; start < ids.length; start += batchSize) {
      const chunk = ids.slice(start, start + batchSize);
      call(chunk).then(
        (values) => {
          chunk.forEach((id, i) => {
            for (const waiter of asked.get(id) ?? []) {
              const value = values[i];
              if (value === undefined) waiter.reject(new Error(`batch: no answer for ${id}`));
              else waiter.resolve(value);
            }
          });
        },
        (error: unknown) => {
          for (const id of chunk) for (const waiter of asked.get(id) ?? []) waiter.reject(error);
        },
      );
    }
  };

  return (id) =>
    new Promise<V>((resolve, reject) => {
      const waiters = queue.get(id);
      if (waiters) waiters.push({ resolve, reject });
      else queue.set(id, [{ resolve, reject }]);
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, 0);
      }
    });
}
