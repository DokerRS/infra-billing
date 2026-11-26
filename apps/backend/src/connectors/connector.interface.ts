import type Decimal from 'decimal.js';

export interface Account {
  /** null for providers without an account balance (e.g. Hetzner). */
  balance: Decimal | null;
  currency: string;
}

export interface ServiceData {
  externalId: string;
  name: string;
  type: string; // vps / domain / ...
  countryCode?: string;
  cost?: Decimal;
  currency?: string;
  period?: string;
  nextBilling?: Date | null;
  meta: Record<string, unknown>;
}

export interface PaymentData {
  /** Provider record id, namespaced to stay unique across ledgers (e.g. "payment:242"/"expense:889"). */
  externalId: string;
  /** `topup` = top-up/payment to the provider; `charge` = charge for a service. */
  type: 'topup' | 'charge';
  amount: Decimal;
  currency: string;
  date: Date;
  description?: string;
  /** For charges: the parent service's externalId, to link the payment to a Service. */
  serviceExternalId?: string;
}

/**
 * One implementation per syncable provider. Reference impl: Timeweb.
 * `manual` providers have no connector and are skipped by the sync.
 */
export interface Connector {
  /** Connector code, e.g. "timeweb". */
  kind(): string;
  /** Account balance + currency. */
  fetchAccount(signal: AbortSignal): Promise<Account>;
  /** Provider resources mapped to our domain model (no DB writes). */
  fetchServices(signal: AbortSignal): Promise<ServiceData[]>;
  /** Optional payment/expense ledger, for providers that expose one (e.g. BILLmanager). */
  fetchPayments?(signal: AbortSignal): Promise<PaymentData[]>;
  /**
   * Optional direct favicon URL, for self-hosted panels whose icon domain-based favicon
   * services can't discover (e.g. BILLmanager keeps it behind a per-install skin path).
   */
  fetchFaviconUrl?(signal: AbortSignal): Promise<string | null>;
  /**
   * Set by the sync when it can persist credentials. Connectors that can renew their own
   * credentials mid-run (a session cookie minted from a stored login/password) call it with the
   * whole replacement credentials blob, so the next run starts from the fresh secret instead of
   * the one the owner pasted. Assigning it is optional for the connector — ignoring it is safe,
   * the run just renews again next time.
   */
  onCredentialsRenewed?: (credentialsJson: string) => void;
}
