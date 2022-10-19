import { BlockhashWithExpiryBlockHeight, Keypair, TransactionInstruction } from '@solana/web3.js';

export type WalletSigner = Pick<any, 'publicKey' | 'signTransaction' | 'signAllTransactions'>;

export class TransactionInstructionWithSigners {
  transactionInstruction: TransactionInstruction;
  signers: Keypair[];
  constructor(transactionInstruction: TransactionInstruction, signers: Keypair[] = []) {
    this.transactionInstruction = transactionInstruction;
    this.signers = signers;
  }
}

export enum SequenceType {
  Sequential,
  Parallel,
  StopOnFailure,
}

/**
 * @param timeout optional (secs) after how much secs not confirmed transaction will be considered timeout, default: 90
 * @param getSignatureStatusesPoolIntervalMs optional (ms) pool interval of getSignatureStatues, default: 2000
 */
export type TimeStrategy = {
  timeout: number;
  getSignatureStatusesPoolIntervalMs?: number;
};

/**
 * @param startBlockCheckAfterSecs optional (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 * @param block BlockhashWithExpiryBlockHeight
 * @param getSignatureStatusesPoolIntervalMs optional (ms) pool interval of getSignatureStatues and blockheight, default: 2000
 */
export type BlockHeightStrategy = {
  startBlockCheckAfterSecs?: number;
  block: BlockhashWithExpiryBlockHeight;
  getSignatureStatusesPoolIntervalMs?: number;
};
export class TimeStrategyClass implements TimeStrategy {
  timeout: number;
  getSignatureStatusesPoolIntervalMs: number;
  constructor({
    timeout = 90,
    getSignatureStatusesPoolIntervalMs = 5000,
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
    startBlockCheckAfterSecs = 90,
    block,
    getSignatureStatusesPoolIntervalMs = 5000,
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
