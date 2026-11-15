/** Sequential step runner: prints each step, stops at the first failure. */

let count = 0;

export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  count++;
  const started = Date.now();
  try {
    const out = await fn();
    console.log(`  ok   ${String(count).padStart(2)}  ${name}  (${Date.now() - started} ms)`);
    return out;
  } catch (e) {
    console.log(`  FAIL ${String(count).padStart(2)}  ${name}`);
    throw e;
  }
}

export function stepsRun(): number {
  return count;
}
