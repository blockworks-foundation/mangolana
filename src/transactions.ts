import {
  Commitment,
  Connection,
  Keypair,
  RpcResponseAndContext,
  SignatureStatus,
  SimulatedTransactionResponse,
  Transaction,
  TransactionConfirmationStatus,
  TransactionSignature,
} from '@solana/web3.js';
import bs58 = require('bs58');
import { getUnixTs, MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION, sleep } from './tools';
import {
  BlockHeightStrategy,
  BlockHeightStrategyClass,
  SequenceType,
  TimeStrategy,
  TimeStrategyClass,
  TransactionInstructionWithType,
  TransactionsPlayingIndexes,
  WalletSigner,
} from './types';

/**
 * waits for transaction confirmation
 * @param timeoutStrategy
 *
 *
 * TimeStrategy: pure timeout strategy
 * {
 *  timeout: optional, (secs) after how much secs not confirmed transaction will be considered timeout, default: 90
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues, default: 2000
 * }
 *
 *
 * BlockHeightStrategy: blockheight pool satrategy
 * {
 *  startBlockCheckAfterSecs: optional, (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 *  block: BlockhashWithExpiryBlockHeight
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues and blockheight, default: 2000
 * }
 */
export const awaitTransactionSignatureConfirmation = async ({
  txid,
  confirmLevel,
  connection,
  timeoutStrategy,
}: {
  txid: TransactionSignature;
  confirmLevel: TransactionConfirmationStatus;
  connection: Connection;
  timeoutStrategy: TimeStrategy | BlockHeightStrategy;
}) => {
  const isBlockHeightStrategy = typeof (timeoutStrategy as BlockHeightStrategy).block !== 'undefined';
  const timeoutConfig = !isBlockHeightStrategy
    ? new TimeStrategyClass({ ...(timeoutStrategy as TimeStrategy) })
    : new BlockHeightStrategyClass({ ...(timeoutStrategy as BlockHeightStrategy) });
  const timeoutBlockHeight = isBlockHeightStrategy
    ? (timeoutConfig as BlockHeightStrategy).block.lastValidBlockHeight + MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION
    : 0;
  const timeout = isBlockHeightStrategy
    ? (timeoutConfig as BlockHeightStrategy).startBlockCheckAfterSecs
    : (timeoutConfig as TimeStrategy).timeout;

  let startTimeoutCheck = false;
  let done = false;
  const confirmLevels: (TransactionConfirmationStatus | null | undefined)[] = ['finalized'];

  if (confirmLevel === 'confirmed') {
    confirmLevels.push('confirmed');
  } else if (confirmLevel === 'processed') {
    confirmLevels.push('confirmed');
    confirmLevels.push('processed');
  }
  let subscriptionId: number | undefined;

  const result = await new Promise((resolve, reject) => {
    (async () => {
      setTimeout(() => {
        if (done) {
          return;
        }
        if (timeoutBlockHeight !== 0) {
          startTimeoutCheck = true;
        } else {
          done = true;
          console.log('Timed out for txid: ', txid);
          reject({ timeout: true });
        }
      }, timeout);
      try {
        subscriptionId = connection.onSignature(
          txid,
          (result, context) => {
            subscriptionId = undefined;
            done = true;
            if (result.err) {
              reject(result.err);
            } else {
              resolve(result);
            }
          },
          'processed',
        );
      } catch (e) {
        done = true;
        console.log('WS error in setup', txid, e);
      }
      const retrySleep = timeoutStrategy.getSignatureStatusesPoolIntervalMs!;
      while (!done) {
        // eslint-disable-next-line no-loop-func
        await sleep(retrySleep);
        (async () => {
          try {
            const promises: [Promise<RpcResponseAndContext<(SignatureStatus | null)[]>>, Promise<number>?] = [
              connection.getSignatureStatuses([txid]),
            ];
            //if startTimeoutThreshold passed we start to check if
            //current blocks are did not passed timeoutBlockHeight threshold
            if (startTimeoutCheck) {
              promises.push(connection.getBlockHeight('confirmed'));
            }
            const [signatureStatuses, currentBlockHeight] = await Promise.all(promises);
            if (typeof currentBlockHeight !== undefined && timeoutBlockHeight <= currentBlockHeight!) {
              console.log('Timed out for txid: ', txid);
              done = true;
              reject({ timeout: true });
            }

            const result = signatureStatuses && signatureStatuses.value[0];
            if (!done) {
              if (!result) return;
              if (result.err) {
                console.log('REST error for', txid, result);
                done = true;
                reject(result.err);
              } else if (!(result.confirmations || confirmLevels.includes(result.confirmationStatus))) {
                console.log('REST not confirmed', txid, result);
              } else {
                console.log('REST confirmed', txid, result);
                done = true;
                resolve(result);
              }
            }
          } catch (e) {
            if (!done) {
              console.log('REST connection error: txid', txid, e);
            }
          }
        })();
      }
    })();
  });

  if (subscriptionId) {
    connection.removeSignatureListener(subscriptionId).catch((e) => {
      console.log('WS error in cleanup', e);
    });
  }

  done = true;
  return result;
};

/**
 * send and waits for transaction to confirm
 * @param postSendTxCallback call back that will fire after sending tx before waiting for tx to be confirmed.
 * @param timeoutStrategy
 *
 *
 * TimeStrategy: pure timeout strategy
 * {
 *  timeout: optional, (secs) after how much secs not confirmed transaction will be considered timeout, default: 90
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues, default: 2000
 * }
 *
 *
 * BlockHeightStrategy: blockheight pool satrategy
 * {
 *  startBlockCheckAfterSecs: optional, (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 *  block: BlockhashWithExpiryBlockHeight
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues and blockheight, default: 2000
 * }
 */
export const sendAndConfirmSignedTransaction = async ({
  signedTransaction,
  confirmLevel = 'processed',
  connection,
  postSendTxCallback,
  timeoutStrategy,
}: {
  signedTransaction: Transaction;
  connection: Connection;
  confirmLevel?: TransactionConfirmationStatus;
  postSendTxCallback?: ({ txid }: { txid: string }) => void;
  timeoutStrategy: TimeStrategy | BlockHeightStrategy;
}) => {
  console.log('34534534');
  const isBlockHeightStrategy = typeof (timeoutStrategy as BlockHeightStrategy).block !== 'undefined';
  const timeoutConfig = !isBlockHeightStrategy
    ? new TimeStrategyClass({ ...(timeoutStrategy as TimeStrategy) })
    : new BlockHeightStrategyClass({ ...(timeoutStrategy as BlockHeightStrategy) });
  const resendTimeout = !isBlockHeightStrategy
    ? (timeoutConfig as TimeStrategy).timeout
    : (timeoutConfig as BlockHeightStrategy).startBlockCheckAfterSecs;

  const rawTransaction = signedTransaction.serialize();
  let txid = bs58.encode(signedTransaction.signatures[0].signature!);
  const startTime = getUnixTs();
  txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
  });

  if (postSendTxCallback) {
    try {
      postSendTxCallback({ txid });
    } catch (e) {
      console.log(`postSendTxCallback error ${e}`);
    }
  }

  let done = false;
  (async () => {
    while (!done && getUnixTs() - startTime < resendTimeout!) {
      await sleep(2000);
      connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
      });
    }
  })();

  try {
    await awaitTransactionSignatureConfirmation({
      txid,
      timeoutStrategy: timeoutStrategy,
      confirmLevel,
      connection,
    });
  } catch (err: any) {
    if (err.timeout) {
      throw { txid };
    }
    let simulateResult: SimulatedTransactionResponse | null = null;
    try {
      simulateResult = (await simulateTransaction(connection, signedTransaction, 'single')).value;
    } catch (e) {
      console.log('Simulate tx failed');
    }
    if (simulateResult && simulateResult.err) {
      if (simulateResult.logs) {
        for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
          const line = simulateResult.logs[i];
          if (line.startsWith('Program log: ')) {
            throw {
              message: 'Transaction failed: ' + line.slice('Program log: '.length),
              txid,
            };
          }
        }
      }
      throw {
        message: JSON.stringify(simulateResult.err),
        txid,
      };
    }
    throw { message: 'Transaction failed', txid };
  } finally {
    done = true;
  }
  return txid;
};

/**
 * sign and send array of transactions in desired batches with different styles of send for each array
 * @param timeoutStrategy
 *
 * BlockHeightStrategy: blockheight pool satrategy
 * {
 *  startBlockCheckAfterSecs: optional, (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 *  block: BlockhashWithExpiryBlockHeight
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues and blockheight, default: 2000
 * }
 */
export const sendSignAndConfirmTransactions = async ({
  connection,
  wallet,
  TransactionInstructions,
  timeoutStrategy,
}: {
  connection: Connection;
  wallet: WalletSigner;
  TransactionInstructions: TransactionInstructionWithType[];
  timeoutStrategy: BlockHeightStrategy;
}) => {
  if (!wallet.publicKey) throw new Error('Wallet not connected!');
  //block will be used for timeout calculation
  //max usable transactions per one sign is 40
  const maxTransactionsInBath = 40;
  const currentTransactions = TransactionInstructions.slice(0, maxTransactionsInBath);
  const unsignedTxns: Transaction[] = [];
  //this object will determine how we run transactions e.g [ParallelTx, SequenceTx, ParallelTx]
  const transactionCallOrchestrator: TransactionsPlayingIndexes[] = [];
  for (let i = 0; i < currentTransactions.length; i++) {
    const transactionInstruction = currentTransactions[i];
    const signers: Keypair[] = [];
    if (transactionInstruction.instructionsSet.length === 0) {
      continue;
    }

    const transaction = new Transaction({ feePayer: wallet.publicKey });
    transactionInstruction.instructionsSet.forEach((instruction) => {
      transaction.add(instruction.transactionInstruction);
      if (instruction.signers.length) {
        signers.push(...instruction.signers);
      }
    });
    transaction.recentBlockhash = timeoutStrategy.block.blockhash;
    if (signers.length) {
      transaction.partialSign(...signers);
    }
    //we take last index of unsignedTransactions to have right indexes because
    //if transactions was empty
    //then unsigned transactions could not mach TransactionInstructions param indexes
    const currentUnsignedTxIdx = unsignedTxns.length;
    const currentTransactionCall = transactionCallOrchestrator[transactionCallOrchestrator.length - 1];
    //we check if last item in current transactions call type is same
    //if not then we create next transaction type
    if (currentTransactionCall && currentTransactionCall.sequenceType === transactionInstruction.sequenceType) {
      //we push reflection of transactionInstruction as object value for retry.
      currentTransactionCall.transactionsIdx.push({
        [currentUnsignedTxIdx]: i,
      });
    } else {
      transactionCallOrchestrator.push({
        //we push reflection of transactionInstruction as object value for retry.
        transactionsIdx: [{ [currentUnsignedTxIdx]: i }],
        sequenceType: transactionInstruction.sequenceType,
      });
    }
    unsignedTxns.push(transaction);
  }
  console.log(transactionCallOrchestrator);
  const signedTxns = await wallet.signAllTransactions(unsignedTxns);
  console.log(
    'Transactions play type order',
    transactionCallOrchestrator.map((x) => {
      return {
        ...x,
        sequenceType: typeof x.sequenceType !== 'undefined' ? SequenceType[Number(x.sequenceType)] : 'Parallel',
      };
    }),
  );
  console.log('Signed transactions', signedTxns);
  try {
    for (const fcn of transactionCallOrchestrator) {
      if (typeof fcn.sequenceType === 'undefined' || fcn.sequenceType === SequenceType.Parallel) {
        //wait for all Parallel
        await Promise.all(
          fcn.transactionsIdx.map((idx) => {
            const transactionIdx = Number(Object.keys(idx)[0]);
            const transactionInstructionIdx = idx[transactionIdx];
            return new Promise(async (resolve, reject) => {
              try {
                const resp = await sendAndConfirmSignedTransaction({
                  connection,
                  signedTransaction: signedTxns[transactionIdx],
                  timeoutStrategy: timeoutStrategy,
                });
                resolve(resp);
              } catch (e) {
                console.log(e);
                if (typeof e === 'object') {
                  reject({
                    ...e,
                    transactionInstructionIdx,
                  });
                } else {
                  reject(e);
                }
              }
            });
          }),
        );
      }
      if (fcn.sequenceType === SequenceType.Sequential) {
        //wait for all Sequential
        for (const idx of fcn.transactionsIdx) {
          const transactionIdx = Number(Object.keys(idx)[0]);
          const transactionInstructionIdx = idx[transactionIdx];
          try {
            await sendAndConfirmSignedTransaction({
              connection,
              signedTransaction: signedTxns[transactionIdx],
              timeoutStrategy: timeoutStrategy,
            });
          } catch (e) {
            console.log(e);
            if (typeof e === 'object') {
              throw {
                ...e,
                transactionInstructionIdx,
              };
            } else {
              throw e;
            }
          }
        }
      }
    }
    //we call recursively our function to forward rest of transactions if
    // number of them is higher then maxTransactionsInBath
    if (TransactionInstructions.length > maxTransactionsInBath) {
      const forwardedTransactions = TransactionInstructions.slice(
        maxTransactionsInBath,
        TransactionInstructions.length,
      );
      await sendSignAndConfirmTransactions({
        connection,
        wallet,
        TransactionInstructions: forwardedTransactions,
        timeoutStrategy: timeoutStrategy,
      });
    }
  } catch (e) {
    console.log(e);
    throw e;
  }
};

/** Copy of Connection.simulateTransaction that takes a commitment parameter. */
export async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
  commitment: Commitment,
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
  // @ts-ignore
  transaction.recentBlockhash = await connection._recentBlockhash(
    // @ts-ignore
    connection._disableBlockhashCaching,
  );

  console.log('simulating transaction', transaction);

  const signData = transaction.serializeMessage();
  // @ts-ignore
  const wireTransaction = transaction._serialize(signData);
  const encodedTransaction = wireTransaction.toString('base64');

  console.log('encoding');
  const config: any = { encoding: 'base64', commitment };
  const args = [encodedTransaction, config];
  console.log('simulating data', args);

  // @ts-ignore
  const res = await connection._rpcRequest('simulateTransaction', args);

  console.log('res simulating transaction', res);
  if (res.error) {
    throw new Error('failed to simulate transaction: ' + res.error.message);
  }
  return res.result;
}
