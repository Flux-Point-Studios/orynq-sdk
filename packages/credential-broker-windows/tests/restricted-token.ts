import koffi from "koffi";

// Lets a single-account test act as another admitted account: a restricted copy of our own token passes an
// access check only for what the DACL grants its restricting SID, here an admitted SID that does not own the pipe.
// The bindings load on first use, so importing this helper loads no DLL off Windows.
function bind() {
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  koffi.struct("RESTRICTING_SID", { Sid: "void *", Attributes: "uint32_t" });
  return {
    GetCurrentProcess: kernel32.func("void * __stdcall GetCurrentProcess()"),
    CloseHandle: kernel32.func("int __stdcall CloseHandle(void *handle)"),
    LocalFree: kernel32.func("void * __stdcall LocalFree(void *memory)"),
    GetLastError: kernel32.func("uint32_t __stdcall GetLastError()"),
    CreateFileW: kernel32.func(
      "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)",
    ),
    OpenProcessToken: advapi32.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)"),
    ConvertStringSidToSidW: advapi32.func("int __stdcall ConvertStringSidToSidW(const char16_t *text, _Out_ void **sid)"),
    CreateRestrictedToken: advapi32.func(
      "int __stdcall CreateRestrictedToken(void *token, uint32_t flags, uint32_t disableCount, void *disable, uint32_t deleteCount, void *privileges, uint32_t restrictCount, RESTRICTING_SID *restrict, _Out_ void **restricted)",
    ),
    DuplicateToken: advapi32.func("int __stdcall DuplicateToken(void *token, int level, _Out_ void **duplicate)"),
    SetThreadToken: advapi32.func("int __stdcall SetThreadToken(void *thread, void *token)"),
    RevertToSelf: advapi32.func("int __stdcall RevertToSelf()"),
  };
}

let bound: ReturnType<typeof bind> | undefined;
const native = () => (bound ??= bind());

const TOKEN_ASSIGN_PRIMARY = 0x1;
const TOKEN_DUPLICATE = 0x2;
const TOKEN_IMPERSONATE = 0x4;
const TOKEN_QUERY = 0x8;
const SECURITY_IMPERSONATION = 2;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const INVALID_HANDLE = 0xffffffffffffffffn;

const must = (operation: string, ok: number) => {
  if (!ok) throw new Error(`${operation} failed with Windows error ${native().GetLastError()}`);
};

/** Runs `action` synchronously on this thread while impersonating our token restricted to `sid`. */
export function whileRestrictedTo<T>(sid: string, action: () => T): T {
  const process = [null];
  const restrictingSid = [null];
  const restricted = [null];
  const impersonation = [null];
  must("OpenProcessToken", native().OpenProcessToken(native().GetCurrentProcess(), TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE | TOKEN_QUERY, process));
  try {
    must("ConvertStringSidToSidW", native().ConvertStringSidToSidW(sid, restrictingSid));
    must("CreateRestrictedToken", native().CreateRestrictedToken(process[0], 0, 0, null, 0, null, 1, { Sid: restrictingSid[0], Attributes: 0 }, restricted));
    must("DuplicateToken", native().DuplicateToken(restricted[0], SECURITY_IMPERSONATION, impersonation));
    must("SetThreadToken", native().SetThreadToken(null, impersonation[0]));
    try {
      return action();
    } finally {
      must("RevertToSelf", native().RevertToSelf());
    }
  } finally {
    for (const handle of [impersonation[0], restricted[0], process[0]]) if (handle) native().CloseHandle(handle);
    if (restrictingSid[0]) native().LocalFree(restrictingSid[0]);
  }
}

/** Opens `path` asking for GENERIC_READ | GENERIC_WRITE; returns 0 on success, else the Windows error. */
export function openWithGenericRights(path: string): number {
  const handle = native().CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, null);
  if (koffi.address(handle) === INVALID_HANDLE) return native().GetLastError();
  native().CloseHandle(handle);
  return 0;
}
