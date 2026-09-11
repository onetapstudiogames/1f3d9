export const OAUTH_LIMITS = Object.freeze({
  formBodyBytes: 8_192,
  authorizationRequestMinutes: 15,
  authorizationCodeMinutes: 5,
  accessTokenMinutes: 10,
  refreshTokenDays: 30,
  authorizationAttemptsPerIpClientHour: 60,
  credentialAttemptsPerIpClientHour: 10,
  signupStartsPerIpHour: 3,
  signupStartsGlobalHour: 300,
  signupStartsPerClientHour: 300,
  signupConfirmsPerIpSessionHour: 10,
  tokenExchangesPerIpClientHour: 120,
  refreshesPerConnectionHour: 120,
  junkRefreshesPerNetworkHour: 120,
  revocationsPerIpClientHour: 120,
} as const)

export const OAUTH_ACCESS_TOKEN_SECONDS = OAUTH_LIMITS.accessTokenMinutes * 60
export const OAUTH_REFRESH_TOKEN_SECONDS = OAUTH_LIMITS.refreshTokenDays * 24 * 60 * 60
