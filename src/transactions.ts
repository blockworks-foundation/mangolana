import {
  AddressLookupTableAccount,
  Commitment,
  Connection,
  Keypair,
  MessageV0,
  RpcResponseAndContext,
  SignatureStatus,
  SimulatedTransactionResponse,
  Transaction,
  TransactionConfirmationStatus,
  TransactionInstruction,
  TransactionSignature,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 = require('bs58');
import { getUnixTs, Logger, sleep } from './tools';
import {
  BlockHeightStrategy,
  BlockHeightStrategyClass,
  getTimeoutConfig,
  SequenceType,
  TimeStrategy,
  TimeStrategyClass,
  TransactionInstructionWithSigners,
  WalletSigner,
  SignaturePubkeyPair,
  isSignaturePubKeyPair,
} from './globalTypes';
import Websocket from 'isomorphic-ws';
import { safeRace } from '@solana/promises';

enum ConfirmationReject {
  Timeout = 'Timeout',
  Aborted = 'Aborted',
}

export interface TransactionInstructionWithType {
  instructionsSet: TransactionInstructionWithSigners[];
  sequenceType?: SequenceType;
}

export interface TransactionsPlayingIndexes {
  transactionsIdx: { [txIdx: number]: number }[];
  sequenceType?: SequenceType;
}

export type awaitTransactionSignatureConfirmationProps = {
  txid: TransactionSignature;
  confirmLevel: TransactionConfirmationStatus;
  connection: Connection;
  timeoutStrategy: TimeStrategy | BlockHeightStrategy;
  config?: {
    logFlowInfo?: boolean;
  };
  abortSignal?: AbortSignal;
};
/**
 * waits for transaction confirmation
 * @param timeoutStrategy TimeStrategy | BlockHeightStrategy
 *
 * TimeStrategy: pure timeout strategy
 *
 *  timeout: optional, (secs) after how much secs not confirmed transaction will be considered timeout, default: 90
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues, default: 4000
 *
 *
 * BlockHeightStrategy: blockheight pool satrategy
 *
 *  startBlockCheckAfterSecs: optional, (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 *  block: BlockhashWithExpiryBlockHeight
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues and blockheight, default: 4000
 * @param config.logFlowInfo when true it will console log process of processing transactions
 */
export const awaitTransactionSignatureConfirmation = async ({
  txid,
  confirmLevel,
  connection,
  timeoutStrategy,
  config,
  abortSignal,
}: awaitTransactionSignatureConfirmationProps) => {
  const abortController = new AbortController();
  const logger = new Logger({ ...config });
  const timeoutConfig = getTimeoutConfig(timeoutStrategy);

  const confirmLevels: TransactionConfirmationStatus[] = ['finalized'];
  if (confirmLevel === 'confirmed') {
    confirmLevels.push('confirmed');
  } else if (confirmLevel === 'processed') {
    confirmLevels.push('confirmed');
    confirmLevels.push('processed');
  }
  try {
    const result: RpcResponseAndContext<SignatureStatus> = await safeRace([
      confirmWithSignatureStatuses(
        txid,
        connection,
        confirmLevels,
        logger,
        timeoutConfig,
        abortController.signal,
        abortSignal,
      ),
      confirmWithWebSockets(txid, connection, confirmLevel, logger, abortController.signal, abortSignal),
      timeoutCheck(txid, timeoutConfig, logger, connection, confirmLevel, abortController.signal, abortSignal),
    ]);
    abortController.abort();
    return result;
  } catch (e) {
    abortController.abort();
    logger.log('await transaction error', e);
    throw e;
  }
};

const confirmWithSignatureStatuses = (
  txid: string,
  connection: Connection,
  confirmLevels: TransactionConfirmationStatus[],
  logger: Logger,
  timeoutConfig: TimeStrategyClass | BlockHeightStrategyClass,
  internalSignal: AbortSignal,
  externalSignal?: AbortSignal,
) => {
  return new Promise<RpcResponseAndContext<SignatureStatus>>(async (resolve, reject) => {
    try {
      const retryTimer = timeoutConfig.getSignatureStatusesPoolIntervalMs || 4000;
      let intervalTimeout: NodeJS.Timeout | null = null;
      const onAbort = () => {
        if (intervalTimeout) {
          clearInterval(intervalTimeout);
        }
        internalSignal.removeEventListener('abort', onAbort);
        externalSignal?.removeEventListener('abort', onAbort);
        reject(ConfirmationReject.Aborted);
      };
      internalSignal.addEventListener('abort', onAbort);
      externalSignal?.addEventListener('abort', onAbort);

      intervalTimeout = setInterval(async () => {
        try {
          const statuses = await connection.getSignatureStatuses([txid]);
          const result =
            statuses && statuses.value.length && statuses.value[0] !== null
              ? {
                  context: statuses.context,
                  value: statuses.value[0],
                }
              : null;
          logger.log('REST result', result);

          if (!result) return;

          if (result.value?.err) {
            logger.log('REST error for', txid, result);
            reject({ value: result.value, context: result.context });
          } else if (
            !(
              result.value?.confirmations ||
              (result.value?.confirmationStatus && confirmLevels.includes(result.value.confirmationStatus))
            )
          ) {
            logger.log('REST not confirmed', txid, result);
          } else {
            logger.log('REST confirmed', txid, result);
            resolve({ value: result.value!, context: result.context });
          }
        } catch (e) {
          logger.log('REST connection error: txid', txid, e);
          reject(e);
        }
      }, retryTimer);
    } catch (e) {
      reject(e);
    }
  });
};

const confirmWithWebSockets = (
  txid: string,
  connection: Connection,
  confirmLevel: TransactionConfirmationStatus,
  logger: Logger,
  internalSignal: AbortSignal,
  externalSignal?: AbortSignal,
) => {
  return new Promise<RpcResponseAndContext<SignatureStatus>>(async (resolve, reject) => {
    try {
      let subscriptionId: number | undefined;
      const tempConnection = new Connection(connection.rpcEndpoint, connection.commitment);
      let websocket: Websocket | null = null;
      const onAbort = () => {
        cleanup();
        reject(ConfirmationReject.Aborted);
      };
      const cleanup = async () => {
        //@ts-ignore
        if (subscriptionId && tempConnection._subscriptionDisposeFunctionsByClientSubscriptionId[subscriptionId]) {
          try {
            await tempConnection.removeSignatureListener(subscriptionId);
          } catch (e) {
            logger.log('WS error in cleanup', e);
          }
        }
        if (websocket && websocket.removeAllListeners) {
          websocket.removeAllListeners();
          websocket = null;
        }
        subscriptionId = undefined;
        internalSignal.removeEventListener('abort', onAbort);
        externalSignal?.removeEventListener('abort', onAbort);
      };
      internalSignal.addEventListener('abort', onAbort);
      externalSignal?.addEventListener('abort', onAbort);
      try {
        logger.log('on signature', txid);
        //In native websockets of web3 there is retry infinity so to prevent connecting to
        //broken rpc we check if websockets are working
        websocket = new Websocket(tempConnection.rpcEndpoint.replace(/^http(s?):\/\//, 'ws$1://'));

        websocket.onerror = function error() {
          websocket?.close();
        };
        websocket.onopen = async () => {
          websocket?.close();
          await sleep(100);
          subscriptionId = tempConnection.onSignature(
            txid,
            (result, context) => {
              if (result.err) {
                cleanup();
                logger.log('WS reject', txid, result);
                reject({ value: result, context });
              } else {
                cleanup();
                logger.log('WS resolve', txid, result);
                //@ts-ignore
                resolve({ value: result, context });
              }
            },
            confirmLevel,
          );
        };
      } catch (e) {
        logger.log('WS error in setup', txid, e);
        cleanup();
        reject(e);
      }
    } catch (e) {
      reject(e);
    }
  });
};

const timeoutCheck = (
  txid: string,
  timeoutConfig: TimeStrategyClass | BlockHeightStrategyClass,
  logger: Logger,
  connection: Connection,
  confirmLevel: TransactionConfirmationStatus,
  internalSignal: AbortSignal,
  externalSignal?: AbortSignal,
) => {
  return new Promise<RpcResponseAndContext<SignatureStatus>>(async (resolve, reject) => {
    try {
      let intervalTimer: NodeJS.Timeout | null = null;
      let setTimeoutTimer: NodeJS.Timeout | null = null;
      let timeoutBlockHeight = 0;
      let timeout = 0;
      if (timeoutConfig instanceof BlockHeightStrategyClass) {
        timeoutBlockHeight = timeoutConfig.block.lastValidBlockHeight;
        timeout = timeoutConfig.startBlockCheckAfterSecs;
      } else {
        timeout = timeoutConfig.timeout;
      }
      const onAbort = () => {
        if (intervalTimer) {
          clearInterval(intervalTimer);
        }
        if (setTimeoutTimer) {
          clearTimeout(setTimeoutTimer);
        }
        internalSignal.removeEventListener('abort', onAbort);
        externalSignal?.removeEventListener('abort', onAbort);
        reject(ConfirmationReject.Aborted);
      };
      internalSignal.addEventListener('abort', onAbort);
      externalSignal?.addEventListener('abort', onAbort);
      const retrySleep = timeoutConfig.getSignatureStatusesPoolIntervalMs || 4000;
      setTimeoutTimer = setTimeout(async () => {
        try {
          if (timeoutBlockHeight !== 0) {
            intervalTimer = setInterval(async () => {
              try {
                const currentBlockHeight = await connection.getBlockHeight(confirmLevel);
                if (typeof currentBlockHeight !== undefined && timeoutBlockHeight <= currentBlockHeight!) {
                  logger.log('Timed out for txid: ', txid);
                  reject(ConfirmationReject.Timeout);
                }
              } catch (e) {
                reject(e);
              }
            }, retrySleep);
          } else {
            logger.log('Timed out for txid: ', txid);
            reject(ConfirmationReject.Timeout);
          }
        } catch (e) {
          reject(e);
        }
      }, timeout);
    } catch (e) {
      reject(e);
    }
  });
};

export type sendAndConfirmSignedTransactionProps = {
  signedTransaction: Transaction | VersionedTransaction;
  connection: Connection;
  confirmLevel?: TransactionConfirmationStatus;
  timeoutStrategy: TimeStrategy | BlockHeightStrategy;
  callbacks?: {
    postSendTxCallback?: ({ txid }: { txid: string }) => void;
    afterTxConfirmation?: () => void;
  };
  config?: {
    resendTxUntilConfirmed?: boolean;
    resendPoolTimeMs?: number;
    logFlowInfo?: boolean;
    skipPreflight?: boolean;
    useVersionedTransactions?: boolean;
  };
  backupConnections?: Connection[];
};

/**
 * send and waits for transaction to confirm
 * @param callbacks sets of callbacks.
 * @param callbacks.postSendTxCallback post send transaction callback
 * @param callbacks.afterTxConfirmation runs after tx confirmation
 * @param timeoutStrategy TimeStrategy | BlockHeightStrategy
 *
 * TimeStrategy: pure timeout strategy
 *
 *  timeout: optional, (secs) after how much secs not confirmed transaction will be considered timeout, default: 90
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues, default: 4000
 *
 *
 * BlockHeightStrategy: blockheight pool satrategy
 *
 *  startBlockCheckAfterSecs: optional, (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 *  block: BlockhashWithExpiryBlockHeight
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues and blockheight, default: 4000
 *
 * @param config.resendTxUntilConfirmed force resend transaction in the mean time of waiting for confirmation, default false
 * @param config.resendPoolTimeMs when resendTxUntilConfirmed is true it will resend transaction every value of ms until there is timeout, default: 2000
 * @param config.logFlowInfo when true it will console log process of processing transactions
 * @param config.skipPreflight
 */
export const sendAndConfirmSignedTransaction = async ({
  signedTransaction,
  confirmLevel = 'processed',
  connection,
  callbacks,
  timeoutStrategy,
  config,
  backupConnections,
}: sendAndConfirmSignedTransactionProps) => {
  const connections = [connection];
  const abortController = new AbortController();
  if (backupConnections && backupConnections.length) {
    connections.push(...backupConnections);
  }
  const logger = new Logger({ ...config });
  const timeoutConfig = getTimeoutConfig(timeoutStrategy);
  let resendTimeout = 0;
  if (timeoutConfig instanceof BlockHeightStrategyClass) {
    resendTimeout = timeoutConfig.startBlockCheckAfterSecs;
  } else {
    resendTimeout = timeoutConfig.timeout;
  }
  if (config?.resendTxUntilConfirmed) {
    config.resendPoolTimeMs ||= 2000;
  }

  const rawTransaction = signedTransaction.serialize();
  let txid = bs58.encode(
    isSignaturePubKeyPair(signedTransaction.signatures[0])
      ? signedTransaction.signatures[0].signature!
      : signedTransaction.signatures[0],
  );

  const startTime = getUnixTs();
  txid = await Promise.any(
    connections.map((c) => {
      return c.sendRawTransaction(rawTransaction, {
        skipPreflight: config?.skipPreflight === undefined ? true : config.skipPreflight,
      });
    }),
  );
  if (callbacks?.postSendTxCallback) {
    try {
      callbacks.postSendTxCallback({ txid });
    } catch (e) {
      logger.log(`postSendTxCallback error ${e}`);
    }
  }

  let done = false;
  if (config?.resendTxUntilConfirmed) {
    (async () => {
      while (!done && getUnixTs() - startTime < resendTimeout!) {
        await sleep(config?.resendPoolTimeMs || 2000);
        connections.map((c) => {
          return c.sendRawTransaction(rawTransaction, {
            skipPreflight: config?.skipPreflight === undefined ? true : config.skipPreflight,
          });
        });
      }
    })();
  }

  try {
    await Promise.any(
      connections.map((c) =>
        awaitTransactionSignatureConfirmation({
          txid,
          timeoutStrategy: timeoutStrategy,
          confirmLevel,
          connection: c,
          config,
          abortSignal: abortController.signal,
        }),
      ),
    );
    abortController.abort();
    if (callbacks?.afterTxConfirmation) {
      callbacks.afterTxConfirmation();
    }
  } catch (err: any) {
    logger.log(err);
    abortController.abort();
    if (err instanceof AggregateError) {
      for (const individualError of err.errors) {
        logger.log(individualError);
        if (individualError === 'Timeout') {
          throw { txid };
        }
        throw { message: 'Transaction failed', txid };
      }
    }
    if (err === 'Timeout') {
      throw { txid };
    }
    let simulateResult: SimulatedTransactionResponse | null = null;
    try {
      simulateResult = (await simulateTransaction(connection, signedTransaction, 'single', config?.logFlowInfo)).value;
    } catch (e) {
      logger.log('Simulate tx failed', e);
    }
    logger.log(simulateResult);
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

export type sendSignAndConfirmTransactionsProps = {
  connection: Connection;
  wallet: WalletSigner;
  transactionInstructions: TransactionInstructionWithType[];
  timeoutStrategy?: BlockHeightStrategy;
  confirmLevel?: TransactionConfirmationStatus;
  callbacks?: {
    afterFirstBatchSign?: (signedTxnsCount: number) => void;
    afterBatchSign?: (signedTxnsCount: number) => void;
    afterAllTxConfirmed?: () => void;
    afterEveryTxConfirmation?: () => void;
    onError?: (
      e: any,
      notProcessedTransactions: TransactionInstructionWithType[],
      originalProps: sendSignAndConfirmTransactionsProps,
    ) => void;
    afterEveryTxSend?: ({ txid }: { txid: string }) => void;
  };
  config?: {
    maxTxesInBatch: number;
    autoRetry: boolean;
    maxRetries?: number;
    retried?: number;
    logFlowInfo?: boolean;
    useVersionedTransactions?: boolean;
  };
  backupConnections?: Connection[];
};
/**
 * sign and send array of transactions in desired batches with different styles of send for each array
 * @param timeoutStrategy
 *
 * BlockHeightStrategy: blockheight pool satrategy
 *
 *  startBlockCheckAfterSecs: optional, (secs) after that time we will start to pool current blockheight and check if transaction will reach blockchain, default: 90
 *  block: BlockhashWithExpiryBlockHeight
 *  getSignatureStatusesPoolIntervalMs: optional, (ms) pool interval of getSignatureStatues and blockheight, default: 4000
 *
 *
 * @param callbacks sets of callbacks
 * @param callbacks.afterFirstBatchSign callback will run only on first batch approval
 * @param callbacks.afterBatchSign callback will run on any batch approval
 * @param callbacks.afterAllTxConfirmed callback will run after all transaction batches are confirmed
 * @param callbacks.afterEveryTxConfirmation callback will run on every single transaction confirmation
 * @param callbacks.onError callback will run on error
 * @param callbacks.afterEveryTxSend callback will run after every sended tx has tx signature as param
 *
 * @param config.maxTxesInBatch max transactions in one batch of transactions, there is limitation on how much wallet can sign in one go depending on used wallet. default 40
 * @param config.autoRetry auto retry on any error approve and send of transaction after error
 * @param config.maxRetries if auto retry is true, it will try this amount of times before actual error, default 5
 * @param config.retired argument passed by recursive function best not to change it, default 0
 * @param config.logFlowInfo when true it will console log process of processing transactions
 * @param config.useVersionedTransactions will send all txes as versioned transactions
 */
export const sendSignAndConfirmTransactions = async ({
  connection,
  wallet,
  transactionInstructions,
  confirmLevel = 'processed',
  timeoutStrategy,
  callbacks,
  config = {
    maxTxesInBatch: 40,
    autoRetry: false,
    maxRetries: 5,
    retried: 0,
    logFlowInfo: false,
    useVersionedTransactions: false,
  },
  backupConnections,
}: sendSignAndConfirmTransactionsProps) => {
  const logger = new Logger({ ...config });
  let block = timeoutStrategy?.block;
  if (!wallet.publicKey) throw new Error('Wallet not connected!');
  if (!block) {
    block = await connection.getLatestBlockhash('confirmed');
  }
  if (typeof config?.retried === 'undefined') {
    config.retried = 0;
  }
  if (typeof config?.maxRetries === 'undefined') {
    config.maxRetries = 5;
  }
  //block will be used for timeout calculation
  //max usable transactions per one sign is 40
  const useVersionedTransactions = config.useVersionedTransactions;
  const maxTransactionsInBath = config.maxTxesInBatch;
  const currentTransactions = transactionInstructions.slice(0, maxTransactionsInBath);
  const unsignedTxns: (Transaction | VersionedTransaction)[] = [];
  //this object will determine how we run transactions e.g [ParallelTx, SequenceTx, ParallelTx]
  const transactionCallOrchestrator: TransactionsPlayingIndexes[] = [];
  for (let i = 0; i < currentTransactions.length; i++) {
    const transactionInstruction = currentTransactions[i];
    if (transactionInstruction.instructionsSet.length === 0) {
      continue;
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

    if (useVersionedTransactions) {
      const ixes: TransactionInstruction[] = [];
      const signers: Keypair[] = [];
      const alts: AddressLookupTableAccount[] = [];

      transactionInstruction.instructionsSet.forEach((instruction) => {
        ixes.push(instruction.transactionInstruction);
        if (instruction.signers?.length) {
          signers.push(...instruction.signers);
        }
        if (instruction.alts?.length) {
          alts.push(...instruction.alts);
        }
      });

      const message = MessageV0.compile({
        payerKey: wallet.publicKey,
        instructions: [...ixes],
        recentBlockhash: block.blockhash,
        addressLookupTableAccounts: [...alts],
      });
      const vtx = new VersionedTransaction(message);
      if (signers?.length) {
        vtx.sign([...signers]);
      }

      unsignedTxns.push(vtx);
    } else {
      const signers: Keypair[] = [];
      const transaction = new Transaction({ feePayer: wallet.publicKey });
      transactionInstruction.instructionsSet.forEach((instruction) => {
        transaction.add(instruction.transactionInstruction);
        if (instruction.signers?.length) {
          signers.push(...instruction.signers);
        }
      });
      transaction.recentBlockhash = block.blockhash;
      if (signers?.length) {
        transaction.partialSign(...signers);
      }
      unsignedTxns.push(transaction);
    }
  }

  logger.log(transactionCallOrchestrator);
  const signedTxns = await wallet.signAllTransactions(unsignedTxns);
  if (callbacks?.afterFirstBatchSign) {
    callbacks.afterFirstBatchSign(signedTxns.length);
  } else if (callbacks?.afterBatchSign) {
    callbacks.afterBatchSign(signedTxns.length);
  }
  logger.log(
    'Transactions play type order',
    transactionCallOrchestrator.map((x) => {
      return {
        ...x,
        sequenceType: typeof x.sequenceType !== 'undefined' ? SequenceType[Number(x.sequenceType)] : 'Parallel',
      };
    }),
  );
  logger.log('Signed transactions', signedTxns);
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
                  confirmLevel,
                  timeoutStrategy: {
                    block: block!,
                  },
                  callbacks: {
                    afterTxConfirmation: callbacks?.afterEveryTxConfirmation,
                    postSendTxCallback: callbacks?.afterEveryTxSend,
                  },
                  config,
                  backupConnections,
                });
                resolve(resp);
              } catch (e) {
                logger.log(e);
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
              confirmLevel,
              timeoutStrategy: {
                block,
              },
              callbacks: {
                afterTxConfirmation: callbacks?.afterEveryTxConfirmation,
                postSendTxCallback: callbacks?.afterEveryTxSend,
              },
              config,
              backupConnections,
            });
          } catch (e) {
            logger.log(e);
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
    if (transactionInstructions.length > maxTransactionsInBath) {
      const forwardedTransactions = transactionInstructions.slice(
        maxTransactionsInBath,
        transactionInstructions.length,
      );
      await sendSignAndConfirmTransactions({
        connection,
        wallet,
        confirmLevel,
        transactionInstructions: forwardedTransactions,
        timeoutStrategy: timeoutStrategy,
        callbacks: {
          afterBatchSign: callbacks?.afterBatchSign,
          afterAllTxConfirmed: callbacks?.afterAllTxConfirmed,
          afterEveryTxConfirmation: callbacks?.afterEveryTxConfirmation,
          afterEveryTxSend: callbacks?.afterEveryTxSend,
          onError: callbacks?.onError,
        },
        config,
        backupConnections,
      });
    }
    if (callbacks?.afterAllTxConfirmed) {
      callbacks.afterAllTxConfirmed();
    }
  } catch (e) {
    logger.log(e);
    if (callbacks?.onError) {
      if (typeof e === 'object' && (e as any).transactionInstructionIdx !== undefined) {
        const idx = (e as any).transactionInstructionIdx;
        const txInstructionForRetry = transactionInstructions.slice(idx, transactionInstructions.length);
        callbacks.onError(e, txInstructionForRetry, {
          connection,
          wallet,
          confirmLevel,
          transactionInstructions,
          timeoutStrategy,
          callbacks,
          config,
        });
      } else {
        callbacks.onError(e, [], {
          connection,
          wallet,
          confirmLevel,
          transactionInstructions,
          timeoutStrategy,
          callbacks,
          config,
        });
      }
    }

    if (config.autoRetry && config.maxRetries >= config.retried) {
      const idx = (e as any)?.transactionInstructionIdx;
      if (typeof idx !== 'undefined') {
        config.retried++;
        logger.log('Auto retry is, on retry number');
        const txInstructionForRetry = transactionInstructions.slice(idx, transactionInstructions.length);
        await sendSignAndConfirmTransactions({
          connection,
          wallet,
          confirmLevel,
          transactionInstructions: txInstructionForRetry,
          callbacks,
          config,
          backupConnections,
        });
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
};

/** Copy of Connection.simulateTransaction that takes a commitment parameter. */
export async function simulateTransaction(
  connection: Connection,
  transaction: Transaction | VersionedTransaction,
  commitment: Commitment,
  logInfo?: boolean,
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
  const logger = new Logger({ logFlowInfo: !!logInfo });
  const latestBlockhash = await connection.getLatestBlockhash();
  if (transaction instanceof Transaction) {
    transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
    transaction.recentBlockhash = latestBlockhash.blockhash;

    logger.log('simulating transaction', transaction);

    const signData = transaction.serializeMessage();

    // @ts-ignore
    const wireTransaction = transaction._serialize(signData);
    const encodedTransaction = wireTransaction.toString('base64');

    logger.log('encoding');
    const config: any = { encoding: 'base64', commitment };
    const args = [encodedTransaction, config];
    logger.log('simulating data', args);

    // @ts-ignore
    const res = await connection._rpcRequest('simulateTransaction', args);

    logger.log('res simulating transaction', res);
    if (res.error) {
      throw new Error('failed to simulate transaction: ' + res.error.message);
    }
    return res.result;
  } else {
    logger.log('simulating transaction', transaction);

    const res = await connection.simulateTransaction(transaction);

    logger.log('res simulating transaction', res);
    if (res.value.err) {
      throw new Error('failed to simulate transaction: ' + res.value.err.toString());
    }
    return res;
  }
}
