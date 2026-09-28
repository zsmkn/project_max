// gateway/（TypeScript）匯入 authMessages.js 時使用的型別宣告。
export function maintenanceAuthorizationMessage(
  vin: string,
  serviceType: string,
  mileage: number,
  description: string,
): Uint8Array;
export function queryAuthorizationMessage(vin: string, expiresAt: string): Uint8Array;
export function pqcKeyRegistrationMessage(identity: string, publicKeyHex: string): Uint8Array;
export function pqcKeyRotationMessage(identity: string, currentVersion: number, newPublicKeyHex: string): Uint8Array;

export interface QueryAuthorization {
  vin: string;
  ownerIdentity: string;
  expiresAt: string;
  signatureHex: string;
}
export function canonicalQueryAuthorization(authorization: QueryAuthorization): string;
export function queryAuthorizationId(authorization: QueryAuthorization): Promise<string>;
