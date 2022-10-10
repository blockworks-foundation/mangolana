import {
  BlockhashWithExpiryBlockHeight,
  Commitment,
  Connection,
  RpcResponseAndContext,
  SignatureStatus,
  SimulatedTransactionResponse,
  Transaction,
  TransactionConfirmationStatus,
  TransactionSignature,
} from '@solana/web3.js';
import bs58 = require('bs58');
import { getUnixTs, sleep } from './tools';

const MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION = 152;

export const awaitTransactionSignatureConfirmation = async ({
  txid,
  timeout,
  confirmLevel,
  connection,
  signedAtBlock,
}: {
  txid: TransactionSignature;
  timeout: number;
  confirmLevel: TransactionConfirmationStatus;
  connection: Connection;
  signedAtBlock?: BlockhashWithExpiryBlockHeight;
}) => {
  const timeoutBlockHeight = signedAtBlock
    ? signedAtBlock.lastValidBlockHeight + MAXIMUM_NUMBER_OF_BLOCKS_FOR_TRANSACTION
    : 0;
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
      let retrySleep = 2000;
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

export const sendAndConfirmSignedTransaction = async ({
  signedTransaction,
  timeout = 90,
  confirmLevel = 'processed',
  signedAtBlock,
  connection,
  postSendTxCallback,
  resendAfterTimeout = false,
}: {
  signedTransaction: Transaction;
  timeout?: number;
  confirmLevel?: TransactionConfirmationStatus;
  signedAtBlock?: BlockhashWithExpiryBlockHeight;
  connection: Connection;
  postSendTxCallback?: ({ txid }: { txid: string }) => void;
  resendAfterTimeout?: boolean;
}) => {
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
  if (!timeout) return txid;

  let done = false;
  if (resendAfterTimeout) {
    (async () => {
      while (!done && getUnixTs() - startTime < timeout) {
        await sleep(2000);
        connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
        });
      }
    })();
  }

  try {
    await awaitTransactionSignatureConfirmation({ txid, timeout, confirmLevel, signedAtBlock, connection });
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
