import koffi from "koffi";

const kernel32 = koffi.load("kernel32.dll");
const advapi32 = koffi.load("advapi32.dll");

koffi.pointer("HANDLE", koffi.opaque());
const OVERLAPPED = koffi.struct("OVERLAPPED", {
  Internal: "uintptr_t",
  InternalHigh: "uintptr_t",
  Offset: "uint32_t",
  OffsetHigh: "uint32_t",
  hEvent: "HANDLE",
});

const CreateFileW = kernel32.func(
  "HANDLE __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, HANDLE template)",
);
const ReadFile = kernel32.func("int __stdcall ReadFile(HANDLE file, void *buffer, uint32_t length, void *read, void *overlapped)");
const WriteFile = kernel32.func("int __stdcall WriteFile(HANDLE file, void *buffer, uint32_t length, void *written, void *overlapped)");
const GetOverlappedResult = kernel32.func(
  "int __stdcall GetOverlappedResult(HANDLE file, void *overlapped, _Out_ uint32_t *transferred, int wait)",
);
const CancelIoEx = kernel32.func("int __stdcall CancelIoEx(HANDLE file, void *overlapped)");
const CreateEventW = kernel32.func("HANDLE __stdcall CreateEventW(void *sa, int manualReset, int initialState, const char16_t *name)");
const SetEvent = kernel32.func("int __stdcall SetEvent(HANDLE event)");
const ResetEvent = kernel32.func("int __stdcall ResetEvent(HANDLE event)");
const WaitForMultipleObjects = kernel32.func(
  "uint32_t __stdcall WaitForMultipleObjects(uint32_t count, HANDLE *handles, int waitAll, uint32_t milliseconds)",
);
const CloseHandle = kernel32.func("int __stdcall CloseHandle(HANDLE handle)");
const LocalFree = kernel32.func("void * __stdcall LocalFree(void *memory)");
const GetLastError = kernel32.func("uint32_t __stdcall GetLastError()");
const GetSecurityInfo = advapi32.func(
  "uint32_t __stdcall GetSecurityInfo(HANDLE handle, int objectType, uint32_t info, _Out_ void **owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)",
);
const ConvertSidToStringSidW = advapi32.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)");

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const SECURITY_SQOS_PRESENT = 0x00100000;
const SECURITY_IDENTIFICATION = 0x00010000;
const SE_KERNEL_OBJECT = 6;
const OWNER_SECURITY_INFORMATION = 0x1;
const INFINITE = 0xffffffff;
const ERROR_BROKEN_PIPE = 109;
const ERROR_PIPE_NOT_CONNECTED = 233;
const ERROR_OPERATION_ABORTED = 995;
const ERROR_IO_PENDING = 997;
const INVALID_HANDLE = 0xffffffffffffffffn;
const MAX_FRAME_BYTES = 16 << 20;

export interface BrokerConnection {
  /** Sends one frame and resolves with the broker's response frame; requests run one at a time. */
  request(frame: Uint8Array): Promise<Buffer>;
  close(): Promise<void>;
}

class WindowsError extends Error {
  constructor(operation: string, readonly code: number) {
    super(`${operation} failed with Windows error ${code}`);
  }
}

class ConnectionEnded extends Error {
  constructor() {
    super("broker connection closed");
  }
}

const isEndOfConnection = (code: number) =>
  code === ERROR_BROKEN_PIPE || code === ERROR_PIPE_NOT_CONNECTED || code === ERROR_OPERATION_ABORTED;

const waitAny = (handles: unknown[]): Promise<number> =>
  new Promise((resolve, reject) =>
    WaitForMultipleObjects.async(handles.length, handles, 0, INFINITE, (error: unknown, index: number) =>
      error ? reject(error) : resolve(index),
    ),
  );

class Overlapped {
  readonly event = CreateEventW(null, 1, 0, null);
  readonly pointer = koffi.alloc(OVERLAPPED, 1);

  arm(): void {
    ResetEvent(this.event);
    koffi.encode(this.pointer, OVERLAPPED, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: this.event });
  }

  dispose(): void {
    CloseHandle(this.event);
    koffi.free(this.pointer);
  }
}

// Settles an overlapped call given the Windows error its start returned (0 when it completed at once).
// On `cancel` the I/O is cancelled and drained before returning, so the OVERLAPPED block is never freed
// while the kernel still owns it.
async function settle(pipe: unknown, io: Overlapped, cancel: unknown, code: number, operation: string): Promise<number> {
  if (code !== 0) {
    if (code !== ERROR_IO_PENDING) throw isEndOfConnection(code) ? new ConnectionEnded() : new WindowsError(operation, code);
    if ((await waitAny([io.event, cancel])) !== 0) {
      CancelIoEx(pipe, io.pointer);
      GetOverlappedResult(pipe, io.pointer, [0], 1);
      throw new ConnectionEnded();
    }
  }
  const transferred: [number] = [0];
  if (!GetOverlappedResult(pipe, io.pointer, transferred, 0)) {
    const code = GetLastError();
    throw isEndOfConnection(code) ? new ConnectionEnded() : new WindowsError(operation, code);
  }
  return transferred[0];
}

async function readExact(pipe: unknown, length: number, io: Overlapped, cancel: unknown): Promise<Buffer> {
  const out = Buffer.alloc(length);
  const memory = koffi.alloc("uint8_t", Math.max(length, 1));
  try {
    let filled = 0;
    while (filled < length) {
      io.arm();
      const started = ReadFile(pipe, memory, length - filled, null, io.pointer);
      const count = await settle(pipe, io, cancel, started ? 0 : GetLastError(), "ReadFile");
      if (count === 0) throw new ConnectionEnded();
      Buffer.from(koffi.view(memory, count)).copy(out, filled);
      filled += count;
    }
    return out;
  } finally {
    koffi.free(memory);
  }
}

async function writeAll(pipe: unknown, data: Buffer, io: Overlapped, cancel: unknown): Promise<void> {
  const memory = koffi.alloc("uint8_t", data.length);
  try {
    new Uint8Array(koffi.view(memory, data.length)).set(data);
    let sent = 0;
    while (sent < data.length) {
      io.arm();
      const started = WriteFile(pipe, memory, data.length - sent, null, io.pointer);
      sent += await settle(pipe, io, cancel, started ? 0 : GetLastError(), "WriteFile");
    }
  } finally {
    koffi.free(memory);
  }
}

function ownerOf(pipe: unknown): string {
  const owner = [null];
  const descriptor = [null];
  const status = GetSecurityInfo(pipe, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION, owner, null, null, null, descriptor);
  if (status !== 0) throw new WindowsError("GetSecurityInfo", status);
  try {
    const text = [null];
    if (!ConvertSidToStringSidW(owner[0], text)) throw new WindowsError("ConvertSidToStringSidW", GetLastError());
    try {
      return koffi.decode(text[0], "char16_t", -1) as string;
    } finally {
      LocalFree(text[0]);
    }
  } finally {
    LocalFree(descriptor[0]);
  }
}

/**
 * Opens the broker pipe at identification level, so the server can learn who is calling but never act
 * as the caller, and refuses it unless `serverSid` owns it: a squatter that created the name first
 * cannot receive a single byte.
 */
export async function connectBroker(path: string, serverSid: string): Promise<BrokerConnection> {
  const pipe = CreateFileW(
    path,
    GENERIC_READ | GENERIC_WRITE,
    0,
    null,
    OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
    null,
  );
  if (koffi.address(pipe) === INVALID_HANDLE) throw new WindowsError("CreateFileW", GetLastError());
  try {
    const owner = ownerOf(pipe);
    if (owner !== serverSid) throw new Error(`pipe ${path} is owned by ${owner}, not ${serverSid}`);
  } catch (error) {
    CloseHandle(pipe);
    throw error;
  }

  const cancel = CreateEventW(null, 1, 0, null);
  const io = new Overlapped();
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const exchange = async (frame: Uint8Array): Promise<Buffer> => {
    if (closed) throw new ConnectionEnded();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(frame.length, 0);
    await writeAll(pipe, Buffer.concat([header, frame]), io, cancel);
    const length = (await readExact(pipe, 4, io, cancel)).readUInt32BE(0);
    if (length > MAX_FRAME_BYTES) throw new Error(`broker sent a ${length}-byte frame`);
    return readExact(pipe, length, io, cancel);
  };

  return {
    request(frame) {
      if (frame.length === 0 || frame.length > MAX_FRAME_BYTES) return Promise.reject(new RangeError("frame must be 1 byte to 16 MiB"));
      const result = queue.then(() => exchange(frame));
      // Callers see each failure through their own `result`; the queue only keeps requests in order.
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      SetEvent(cancel);
      await queue;
      CloseHandle(pipe);
      CloseHandle(cancel);
      io.dispose();
    },
  };
}
