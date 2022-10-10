export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getUnixTs() {
  return new Date().getTime() / 1000;
}
