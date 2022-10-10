import { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { Keypair, TransactionInstruction } from '@solana/web3.js';

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
