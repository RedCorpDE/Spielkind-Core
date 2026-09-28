export class DomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsufficientCapacityError extends DomainError {
  constructor(message = 'The requested capacity is no longer available.') {
    super('INSUFFICIENT_CAPACITY', message);
  }
}

export class BookingNotCancellableError extends DomainError {
  constructor(message = 'This booking cannot be cancelled.') {
    super('BOOKING_NOT_CANCELLABLE', message);
  }
}

export class InvalidBookingTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super('INVALID_BOOKING_TRANSITION', `Booking cannot transition from ${from} to ${to}.`);
  }
}

export class HoldExpiredError extends DomainError {
  constructor(message = 'The reservation hold has expired.') {
    super('HOLD_EXPIRED', message);
  }
}

export class PaymentRequiredError extends DomainError {
  constructor(message = 'Payment is required before this operation can complete.') {
    super('PAYMENT_REQUIRED', message);
  }
}

export class ProviderUnavailableError extends DomainError {
  constructor(message = 'The booking provider is temporarily unavailable.') {
    super('PROVIDER_UNAVAILABLE', message);
  }
}

export class ProviderSyncConflictError extends DomainError {
  constructor(message = 'The provider record conflicts with the current Core record.') {
    super('PROVIDER_SYNC_CONFLICT', message);
  }
}

