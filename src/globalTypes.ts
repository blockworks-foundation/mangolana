import {
  AddressLookupTableAccount,
  BlockhashWithExpiryBlockHeight,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';

export type WalletSigner = Pick<any, 'publicKey' | 'signTransaction' | 'signAllTransactions'>;

export class TransactionInstructionWithSigners {
  transactionInstruction: TransactionInstruction;
  signers?: Keypair[] = [];
  alts?: AddressLookupTableAccount[] = [];
  constructor(
    transactionInstruction: TransactionInstruction,
    signers: Keypair[] = [],
    alts: AddressLookupTableAccount[] = [],
  ) {
    this.transactionInstruction = transactionInstruction;
    this.signers = signers;
    this.alts = alts;
  }
}

export enum SequenceType {
  Sequential,
  Parallel,
  StopOnFailure,
}

export interface TimeoutStrategy {
  getSignatureStatusesPoolIntervalMs?: number;
}

/**
 * @param timeout optional (secs) after how much secs not confirmed transaction will be considered timeout, default: 90
 * @param getSignatureStatusesPoolIntervalMs optional (ms) pool interval of getSignatureStatues, default: 4000
 */
export interface Time {
  timeout: number;
}
/**
 * @param startBlockCheckAfterSecs optional (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 * @param block BlockhashWithExpiryBlockHeight
 * @param getSignatureStatusesPoolIntervalMs optional (ms) pool interval of getSignatureStatues and blockheight, default: 4000
 */
export interface BlockHeight {
  startBlockCheckAfterSecs?: number;
  block: BlockhashWithExpiryBlockHeight;
}
export class TimeStrategyClass implements TimeStrategy {
  timeout: number;
  getSignatureStatusesPoolIntervalMs: number;
  constructor({
    timeout = 90,
    getSignatureStatusesPoolIntervalMs = 4000,
  }: {
    timeout: number;
    getSignatureStatusesPoolIntervalMs?: number;
  }) {
    this.timeout = timeout;
    this.getSignatureStatusesPoolIntervalMs = getSignatureStatusesPoolIntervalMs;
  }
}
export class BlockHeightStrategyClass implements BlockHeightStrategy {
  startBlockCheckAfterSecs: number;
  block: BlockhashWithExpiryBlockHeight;
  getSignatureStatusesPoolIntervalMs: number;
  constructor({
    startBlockCheckAfterSecs = 10,
    block,
    getSignatureStatusesPoolIntervalMs = 4000,
  }: {
    block: BlockhashWithExpiryBlockHeight;
    getSignatureStatusesPoolIntervalMs?: number;
    startBlockCheckAfterSecs?: number;
  }) {
    this.startBlockCheckAfterSecs = startBlockCheckAfterSecs;
    this.block = block;
    this.getSignatureStatusesPoolIntervalMs = getSignatureStatusesPoolIntervalMs;
  }
}

export type BlockHeightStrategy = TimeoutStrategy & BlockHeight;
export type TimeStrategy = TimeoutStrategy & Time;

export const isBlockHeightStrategy = (
  timeoutStrategy: BlockHeightStrategy | TimeStrategy,
): timeoutStrategy is BlockHeightStrategy => {
  return 'block' in (timeoutStrategy as BlockHeightStrategy);
};

export const getTimeoutConfig = (timeoutStrategy: BlockHeightStrategy | TimeStrategy) => {
  const isBhStrategy = isBlockHeightStrategy(timeoutStrategy);
  const timeoutConfig = !isBhStrategy
    ? new TimeStrategyClass({ ...timeoutStrategy })
    : new BlockHeightStrategyClass({ ...timeoutStrategy });
  return timeoutConfig;
};

export type SignaturePubkeyPair = {
  signature: Buffer | null;
  publicKey: PublicKey;
};

export function isSignaturePubKeyPair(sigPubkey: any): sigPubkey is SignaturePubkeyPair {
  return sigPubkey?.signature !== undefined;
}
