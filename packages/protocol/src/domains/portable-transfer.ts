/** Native dialogs own the file selection, confirmation and passphrase. */
export interface PortableTransferReceipt {
  fileName: string;
  bytes: number;
  formatVersion: number;
  schemaVersion: number;
  credentialsIncluded: false;
  activeAuthorityIncluded: false;
  accountBindingDigest: string;
}

export interface PortableTransferImportReport {
  threads: number;
  messages: number;
  revisions: number;
  agents: number;
  memoryRecords: number;
  knowledgeSources: number;
  credentialsReconnected: false;
  authorityRecreated: false;
  requiresRestart: boolean;
  omitted: {
    credentials: string[];
    authority: string[];
    machineSpecific: string[];
    unsupportedHistory: string[];
  };
}
