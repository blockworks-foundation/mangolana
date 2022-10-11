import { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { BlockhashWithExpiryBlockHeight, Keypair, TransactionInstruction } from '@solana/web3.js';

export class TransactionInstructionWithSigners {
  transactionInstruction: TransactionInstruction;
  signers: Keypair[];
  constructor(transactionInstruction: TransactionInstruction, signers: Keypair[] = []) {
    this.transactionInstruction = transactionInstruction;
    this.signers = signers;
  }
}

export class _TransactionInstructionWithIndex extends TransactionInstructionWithSigners {
  index: number;
  constructor(transactionInstruction: TransactionInstruction, signers: Keypair[] = [], index: number) {
    super(transactionInstruction, signers);
    this.index = index;
  }
}

export type _SendedTransactionWithTimestamp = {
  id: string;
  timestamp: number;
  index: number;
  sendedAtBlock: number;
};

export type _SendedTransactionWithIndex = {
  id: string;
  index: number;
};

export type WalletSigner = Pick<SignerWalletAdapter, 'publicKey' | 'signTransaction' | 'signAllTransactions'>;

export interface TransactionInstructionWithType {
  instructionsSet: TransactionInstructionWithSigners[];
  sequenceType?: SequenceType;
}

export interface TransactionsPlayingIndexes {
  transactionsIdx: { [txIdx: number]: number }[];
  sequenceType?: SequenceType;
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
    getSignatureStatusesPoolIntervalMs = 2000,
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
    getSignatureStatusesPoolIntervalMs = 2000,
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
