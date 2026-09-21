export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

// Runs at most `max` tasks at once; a finished task hands its slot straight to the next waiter.
export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
