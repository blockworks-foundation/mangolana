export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getUnixTs() {
  return new Date().getTime() / 1000;
}

export function chunks<T>(array: T[], size: number): T[][] {
  const result: Array<T[]> = [];
  let i, j;
  for (i = 0, j = array.length; i < j; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

export const MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION = 152;

export class Logger {
  logFlowInfo: boolean = false;
  constructor({ logFlowInfo = false }: { logFlowInfo?: boolean }) {
    this.logFlowInfo = logFlowInfo;
  }
  log(message?: any, ...optionalParams: any[]) {
    if (this.logFlowInfo) {
      console.log(message, ...optionalParams);
    }
  }
}
