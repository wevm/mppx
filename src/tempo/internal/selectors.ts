import { AbiItem } from 'ox'
import { Abis } from 'viem/tempo'

export const approve = /*#__PURE__*/ AbiItem.getSelector(Abis.tip20, 'approve')
export const transfer = /*#__PURE__*/ AbiItem.getSelector(Abis.tip20, 'transfer')
export const transferWithMemo = /*#__PURE__*/ AbiItem.getSelector(Abis.tip20, 'transferWithMemo')
export const swapExactAmountOut = /*#__PURE__*/ AbiItem.getSelector(
  Abis.stablecoinDex,
  'swapExactAmountOut',
)
