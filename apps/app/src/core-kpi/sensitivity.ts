// Simulator sensitivity table: cash-flow and net yield for loan rates × purchase price changes.
// The down payment keeps the same share of the price.
import { analyzeDeal, type DealInput } from './deal.ts';

export type SensitivityRow = {
  rate: number;
  cells: { priceChange: number; cashFlowMonthly: number; netYield: number | null }[];
};

export const sensitivity = (input: DealInput, rates: number[], priceChanges: number[]): SensitivityRow[] => {
  const downShare = input.price > 0 ? input.downPayment / input.price : 0;
  return rates.map((rate) => ({
    rate,
    cells: priceChanges.map((priceChange) => {
      const price = Math.round(input.price * (1 + priceChange));
      const deal = analyzeDeal({ ...input, loanRate: rate, price, downPayment: Math.round(price * downShare) });
      return { priceChange, cashFlowMonthly: deal.cashFlowMonthly, netYield: deal.netYield };
    }),
  }));
};
