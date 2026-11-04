// Promise cache for published files: one fetch per key, but a failure is dropped so "Réessayer" refetches.
export const cached = <T>(load: (key: string) => Promise<T>): ((key: string) => Promise<T>) => {
  const promises = new Map<string, Promise<T>>();
  return (key) => {
    let promise = promises.get(key);
    if (!promise) {
      promise = load(key).catch((error: unknown) => {
        promises.delete(key);
        throw error;
      });
      promises.set(key, promise);
    }
    return promise;
  };
};
