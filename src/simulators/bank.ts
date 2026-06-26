import { bankWebhookTopup } from '../modules/topup.js';

function newBankRef(): string {
  return `BNK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export async function simulateBankTransfer(params: {
  virtualIban: string;
  amountSar: number;
  bankReference?: string;
}) {
  const { virtualIban, amountSar } = params;
  const bankReference = params.bankReference ?? newBankRef();

  const amountHalalas = BigInt(Math.round(amountSar * 100));

  const result = await bankWebhookTopup({ bankReference, virtualIban, amountHalalas });

  if (!result) {
    return {
      bank_reference: bankReference,
      virtual_iban: virtualIban,
      amount_sar: amountSar,
      status: 'DUPLICATE',
    };
  }

  return {
    bank_reference: bankReference,
    virtual_iban: virtualIban,
    amount_sar: amountSar,
    amount_halalas: result.amount_halalas,
    wallet_id: result.wallet_id,
    status: 'CREDITED',
  };
}
