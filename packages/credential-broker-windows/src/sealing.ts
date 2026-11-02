import koffi from "koffi";

const ncrypt = koffi.load("ncrypt.dll");

koffi.pointer("NCRYPT_HANDLE", koffi.opaque());
koffi.struct("BCRYPT_OAEP_PADDING_INFO", { pszAlgId: "const char16_t *", pbLabel: "void *", cbLabel: "uint32_t" });

const NCryptOpenStorageProvider = ncrypt.func(
  "int32_t __stdcall NCryptOpenStorageProvider(_Out_ NCRYPT_HANDLE *provider, const char16_t *name, uint32_t flags)",
);
const NCryptOpenKey = ncrypt.func(
  "int32_t __stdcall NCryptOpenKey(NCRYPT_HANDLE provider, _Out_ NCRYPT_HANDLE *key, const char16_t *name, uint32_t legacyKeySpec, uint32_t flags)",
);
const NCryptCreatePersistedKey = ncrypt.func(
  "int32_t __stdcall NCryptCreatePersistedKey(NCRYPT_HANDLE provider, _Out_ NCRYPT_HANDLE *key, const char16_t *algorithm, const char16_t *name, uint32_t legacyKeySpec, uint32_t flags)",
);
const NCryptSetProperty = ncrypt.func(
  "int32_t __stdcall NCryptSetProperty(NCRYPT_HANDLE object, const char16_t *property, void *input, uint32_t size, uint32_t flags)",
);
const NCryptFinalizeKey = ncrypt.func("int32_t __stdcall NCryptFinalizeKey(NCRYPT_HANDLE key, uint32_t flags)");
const NCryptEncrypt = ncrypt.func(
  "int32_t __stdcall NCryptEncrypt(NCRYPT_HANDLE key, void *input, uint32_t inputSize, BCRYPT_OAEP_PADDING_INFO *padding, void *output, uint32_t outputSize, _Out_ uint32_t *result, uint32_t flags)",
);
const NCryptDecrypt = ncrypt.func(
  "int32_t __stdcall NCryptDecrypt(NCRYPT_HANDLE key, void *input, uint32_t inputSize, BCRYPT_OAEP_PADDING_INFO *padding, void *output, uint32_t outputSize, _Out_ uint32_t *result, uint32_t flags)",
);
const NCryptDeleteKey = ncrypt.func("int32_t __stdcall NCryptDeleteKey(NCRYPT_HANDLE key, uint32_t flags)");
const NCryptFreeObject = ncrypt.func("int32_t __stdcall NCryptFreeObject(NCRYPT_HANDLE object)");

const PLATFORM_CRYPTO_PROVIDER = "Microsoft Platform Crypto Provider";
const NCRYPT_SILENT_FLAG = 0x40;
const NCRYPT_PAD_OAEP_FLAG = 0x4;
const NTE_BAD_KEYSET = 0x80090016;
const KEY_BITS = 2048;
const MAX_SECRET_BYTES = KEY_BITS / 8 - 2 * 32 - 2;
const OAEP_SHA256 = { pszAlgId: "SHA256", pbLabel: null, cbLabel: 0 };

class NCryptError extends Error {
  constructor(operation: string, readonly status: number) {
    super(`${operation} failed with status 0x${status.toString(16)}`);
  }
}

const check = (operation: string, status: number): void => {
  if (status !== 0) throw new NCryptError(operation, status >>> 0);
};

function withProvider<T>(use: (provider: unknown) => T): T {
  const provider = [null];
  check("NCryptOpenStorageProvider", NCryptOpenStorageProvider(provider, PLATFORM_CRYPTO_PROVIDER, 0));
  try {
    return use(provider[0]);
  } finally {
    NCryptFreeObject(provider[0]);
  }
}

function openKey(provider: unknown, name: string): unknown {
  const key = [null];
  check("NCryptOpenKey", NCryptOpenKey(provider, key, name, 0, NCRYPT_SILENT_FLAG));
  return key[0];
}

function openOrCreateKey(provider: unknown, name: string): unknown {
  try {
    return openKey(provider, name);
  } catch (error) {
    if (!(error instanceof NCryptError && error.status === NTE_BAD_KEYSET)) throw error;
  }
  const key = [null];
  check("NCryptCreatePersistedKey", NCryptCreatePersistedKey(provider, key, "RSA", name, 0, NCRYPT_SILENT_FLAG));
  try {
    const bits = Buffer.alloc(4);
    bits.writeUInt32LE(KEY_BITS, 0);
    check("NCryptSetProperty", NCryptSetProperty(key[0], "Length", bits, bits.length, NCRYPT_SILENT_FLAG));
    check("NCryptFinalizeKey", NCryptFinalizeKey(key[0], NCRYPT_SILENT_FLAG));
    return key[0];
  } catch (error) {
    NCryptDeleteKey(key[0], 0);
    throw error;
  }
}

function transform(fn: typeof NCryptEncrypt, operation: string, key: unknown, input: Uint8Array): Buffer {
  const size: [number] = [0];
  check(operation, fn(key, input, input.length, OAEP_SHA256, null, 0, size, NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG));
  const output = Buffer.alloc(size[0]);
  try {
    check(operation, fn(key, input, input.length, OAEP_SHA256, output, output.length, size, NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG));
    return Buffer.from(output.subarray(0, size[0]));
  } finally {
    output.fill(0);
  }
}

// RSA-OAEP under a Platform Crypto Provider key in the calling account's key store; the TPM never
// releases the private half, so a sealed blob opens only on this machine, for this account.
export function sealSecret(keyName: string, secret: Uint8Array): Buffer {
  if (secret.length > MAX_SECRET_BYTES) throw new RangeError(`sealSecret: secret must be at most ${MAX_SECRET_BYTES} bytes`);
  return withProvider((provider) => {
    const key = openOrCreateKey(provider, keyName);
    try {
      return transform(NCryptEncrypt, "NCryptEncrypt", key, secret);
    } finally {
      NCryptFreeObject(key);
    }
  });
}

export function unsealSecret(keyName: string, sealed: Uint8Array): Buffer {
  return withProvider((provider) => {
    const key = openKey(provider, keyName);
    try {
      return transform(NCryptDecrypt, "NCryptDecrypt", key, sealed);
    } finally {
      NCryptFreeObject(key);
    }
  });
}

export function deleteSealingKey(keyName: string): void {
  withProvider((provider) => {
    const key = openKey(provider, keyName);
    const status = NCryptDeleteKey(key, 0);
    if (status !== 0) {
      NCryptFreeObject(key);
      check("NCryptDeleteKey", status);
    }
  });
}
