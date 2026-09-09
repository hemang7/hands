// Synthetic data only. No real people, no real accounts.
export interface Account {
  suffix: string;
  type: string;
  nickname: string;
  balance: number;
}
export interface Member {
  id: string;
  name: string;
  since: string;
  status: 'Active' | 'Restricted';
  accounts: Account[];
}

export const MEMBERS: Record<string, Member> = {
  '10001': {
    id: '10001',
    name: 'RUIZ, ANA M',
    since: '03/14/2011',
    status: 'Active',
    accounts: [
      { suffix: 'S01', type: 'Share Savings', nickname: 'PRIMARY SAVINGS', balance: 4812.33 },
      { suffix: 'S02', type: 'Share Draft', nickname: 'CHECKING', balance: 1203.9 },
    ],
  },
  '10002': {
    id: '10002',
    name: 'OKAFOR, DANIEL',
    since: '11/02/2019',
    status: 'Active',
    accounts: [{ suffix: 'S01', type: 'Share Savings', nickname: 'PRIMARY SAVINGS', balance: 250.0 }],
  },
  '10003': {
    id: '10003',
    name: 'NGUYEN, LINH T',
    since: '07/22/2004',
    status: 'Active',
    accounts: [
      { suffix: 'S01', type: 'Share Savings', nickname: 'PRIMARY SAVINGS', balance: 15987.12 },
      { suffix: 'S02', type: 'Share Draft', nickname: 'CHECKING', balance: 3320.45 },
      { suffix: 'L01', type: 'Auto Loan', nickname: '2022 CIVIC', balance: -11250.0 },
    ],
  },
  // Restricted member: tellers lack privileges to open sub-accounts.
  '55555': {
    id: '55555',
    name: 'ESTATE OF HOLLOWAY, R',
    since: '01/09/1998',
    status: 'Restricted',
    accounts: [{ suffix: 'S01', type: 'Share Savings', nickname: 'ESTATE SAVINGS', balance: 72000.0 }],
  },
};

export const USERS: Record<string, { password: string; role: 'teller' | 'supervisor'; display: string }> = {
  teller1: { password: 'teller1-pass', role: 'teller', display: 'T. SMITH (TELLER)' },
  super1: { password: 'super1-pass', role: 'supervisor', display: 'J. DOE (SUPERVISOR)' },
};

export function fmtMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
