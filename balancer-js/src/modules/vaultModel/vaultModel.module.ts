import { BigNumber } from '@ethersproject/bignumber';
import { Zero } from '@ethersproject/constants';
import { PoolDataService } from '@balancer-labs/sor';

import { PoolModel } from './poolModel/poolModel';
import { JoinPoolRequest } from './poolModel/join';
import { ExitPoolRequest } from './poolModel/exit';
import { BatchSwapRequest } from './poolModel/swap';
import { RelayerModel } from './relayer';
import { PoolsSource } from './poolSource';

export enum ActionType {
  BatchSwap,
  Join,
  Exit,
}

export type Requests = BatchSwapRequest | JoinPoolRequest | ExitPoolRequest;

/**
 * Controller / use-case layer for interacting with pools data.
 */
export class VaultModel {
  poolsSource: PoolsSource;

  constructor(poolDataService: PoolDataService, wrappedNativeAsset: string) {
    this.poolsSource = new PoolsSource(poolDataService, wrappedNativeAsset);
  }

  updateDeltas(
    deltas: Record<string, BigNumber>,
    assets: string[],
    amounts: string[]
  ): Record<string, BigNumber> {
    assets.forEach((t, i) => {
      if (!deltas[t]) deltas[t] = Zero;
      deltas[t] = deltas[t].add(amounts[i]);
    });
    return deltas;
  }

  async multicall(rawCalls: Requests[]): Promise<Record<string, BigNumber>> {
    const relayerModel = new RelayerModel();
    const poolModel = new PoolModel(relayerModel);
    const pools = await this.poolsSource.poolsDictionary();
    const deltas: Record<string, BigNumber> = {};
    for (const call of rawCalls) {
      if (call.actionType === ActionType.Join) {
        const [tokens, amounts] = await poolModel.doJoin(call, pools);
        // const [tokens, amounts] = await this.doJoinPool(call);
        this.updateDeltas(deltas, tokens, amounts);
      } else if (call.actionType === ActionType.Exit) {
        const [tokens, amounts] = await poolModel.doExit(call, pools);
        this.updateDeltas(deltas, tokens, amounts);
      } else {
        const swapDeltas = await poolModel.doBatchSwap(call, pools);
        this.updateDeltas(deltas, call.assets, swapDeltas);
      }
    }
    return deltas;
  }
}
