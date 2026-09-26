export interface ClientProfile {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  onboardingCompleted: boolean;
  avatarUrl: string | null;
  phone: string | null;
}

export interface AuthenticatedClient {
  sessionId: string;
  client: ClientProfile;
}

export interface ClientAccessTokenPayload {
  type: 'client_access';
  sub: string;
  sid: string;
  iat: number;
  exp: number;
}
