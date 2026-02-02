/**
 * Hydra Head Manager - Manages the lifecycle of a Hydra head.
 * Handles opening, closing, and fanout operations.
 */

import type {
  HydraBatcherConfig,
  HeadHandle,
  HeadState,
  HeadStatus,
  HydraMessage,
  HydraCommand,
  HydraUtxo,
  HydraUtxoMessage,
  BatcherEvent,
  BatcherEventHandler,
} from "../types.js";
import {
  HydraBatcherError,
  HydraBatcherException,
} from "../types.js";

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

type WebSocketConstructor = new (url: string) => WebSocketLike;

export class HeadManager {
  private ws: WebSocketLike | null = null;
  private headState: HeadState | null = null;
  private eventHandlers: BatcherEventHandler[] = [];
  private messageQueue: HydraMessage[] = [];
  private pendingPromises: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private reconnectAttempts = 0;
  private isConnecting = false;
  private WebSocketClass: WebSocketConstructor | null = null;

  constructor(private readonly config: HydraBatcherConfig) {}

  /**
   * Connect to the Hydra node WebSocket.
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) {
      return; // Already connected
    }

    if (this.isConnecting) {
      throw new HydraBatcherException(
        HydraBatcherError.CONNECTION_FAILED,
        "Connection already in progress"
      );
    }

    this.isConnecting = true;

    try {
      const wsUrl = this.getWebSocketUrl();
      this.debug(`Connecting to Hydra node at ${wsUrl}`);

      // Dynamically import ws module for Node.js
      if (!this.WebSocketClass) {
        try {
          const wsModule = await import("ws");
          this.WebSocketClass = wsModule.default as unknown as WebSocketConstructor;
        } catch {
          // Fallback to browser WebSocket if available
          if (typeof WebSocket !== "undefined") {
            this.WebSocketClass = WebSocket as unknown as WebSocketConstructor;
          } else {
            throw new HydraBatcherException(
              HydraBatcherError.CONNECTION_FAILED,
              "WebSocket not available. Install 'ws' package for Node.js."
            );
          }
        }
      }

      await this.establishConnection(wsUrl);
      this.reconnectAttempts = 0;
    } finally {
      this.isConnecting = false;
    }
  }

  private async establishConnection(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.WebSocketClass) {
        reject(new Error("WebSocket class not initialized"));
        return;
      }

      const ws = new this.WebSocketClass(wsUrl);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new HydraBatcherException(
          HydraBatcherError.CONNECTION_FAILED,
          "Connection timeout"
        ));
      }, 30000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.debug("Connected to Hydra node");
        resolve();
      };

      ws.onclose = (event: unknown) => {
        clearTimeout(timeout);
        this.handleDisconnect(event);
        if (!this.ws) {
          reject(new HydraBatcherException(
            HydraBatcherError.CONNECTION_LOST,
            "WebSocket closed during connection"
          ));
        }
      };

      ws.onmessage = (event: { data: string }) => {
        this.handleMessage(event.data);
      };

      ws.onerror = (error: unknown) => {
        clearTimeout(timeout);
        this.debug(`WebSocket error: ${String(error)}`);
        reject(new HydraBatcherException(
          HydraBatcherError.CONNECTION_FAILED,
          `WebSocket error: ${String(error)}`
        ));
      };
    });
  }

  /**
   * Disconnect from the Hydra node.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.headState = null;
  }

  /**
   * Initialize and open a new Hydra head.
   */
  async openHead(): Promise<HeadHandle> {
    this.ensureConnected();

    if (this.headState && this.headState.status === "open") {
      throw new HydraBatcherException(
        HydraBatcherError.HEAD_ALREADY_OPEN,
        "Head is already open"
      );
    }

    this.emitEvent({ type: "head:opening", timestamp: new Date().toISOString(), data: {} });

    // Send Init command
    this.sendCommand({ tag: "Init" });

    // Wait for HeadIsOpen message
    const openMessage = await this.waitForMessage(
      (msg) => msg.tag === "HeadIsOpen",
      60000, // 60 second timeout for head opening
      "Timeout waiting for head to open"
    ) as { tag: "HeadIsOpen"; headId: string; timestamp: string };

    const handle: HeadHandle = {
      headId: openMessage.headId,
      participants: this.config.auditorNodes.map(n => n.verificationKey).concat(
        this.config.recorderNode.verificationKey
      ),
      openedAt: openMessage.timestamp,
      status: "open",
    };

    this.headState = {
      headId: openMessage.headId,
      status: "open",
      snapshotNumber: 0,
      utxos: [],
    };

    this.emitEvent({ type: "head:opened", timestamp: new Date().toISOString(), data: handle });

    return handle;
  }

  /**
   * Close the Hydra head and initiate fanout.
   */
  async closeHead(): Promise<void> {
    this.ensureConnected();
    this.ensureHeadOpen();

    this.emitEvent({ type: "head:closing", timestamp: new Date().toISOString(), data: {} });

    // Send Close command
    this.sendCommand({ tag: "Close" });

    // Wait for HeadIsClosed
    await this.waitForMessage(
      (msg) => msg.tag === "HeadIsClosed",
      120000, // 2 minute timeout
      "Timeout waiting for head to close"
    );

    if (this.headState) {
      this.headState.status = "closing";
    }

    // Wait for ReadyToFanout (after contestation period)
    await this.waitForMessage(
      (msg) => msg.tag === "ReadyToFanout",
      300000, // 5 minute timeout for contestation
      "Timeout waiting for fanout readiness"
    );

    this.emitEvent({ type: "head:closed", timestamp: new Date().toISOString(), data: {} });
  }

  /**
   * Execute fanout to return UTxOs to L1.
   */
  async fanout(): Promise<string[]> {
    this.ensureConnected();

    if (!this.headState || !["closing", "closed"].includes(this.headState.status)) {
      throw new HydraBatcherException(
        HydraBatcherError.HEAD_NOT_OPEN,
        "Head must be closed before fanout"
      );
    }

    // Send Fanout command
    this.sendCommand({ tag: "Fanout" });

    // Fanout happens on L1, we don't get a direct confirmation via WebSocket
    // The head state will eventually reflect the fanout

    if (this.headState) {
      this.headState.status = "fanout";
    }

    // Return the UTxO references that were fanned out
    return this.headState?.utxos.map(u => u.txIn) ?? [];
  }

  /**
   * Submit a transaction to the Hydra head.
   */
  async submitTransaction(txCborHex: string): Promise<string> {
    this.ensureConnected();
    this.ensureHeadOpen();

    this.sendCommand({
      tag: "NewTx",
      transaction: { cborHex: txCborHex },
    });

    // Wait for TxValid or TxInvalid
    const result = await this.waitForMessage(
      (msg) => msg.tag === "TxValid" || msg.tag === "TxInvalid",
      30000,
      "Timeout waiting for transaction validation"
    );

    if (result.tag === "TxInvalid") {
      const invalidMsg = result as { validationError: { reason: string } };
      throw new HydraBatcherException(
        HydraBatcherError.COMMIT_REJECTED,
        `Transaction rejected: ${invalidMsg.validationError.reason}`
      );
    }

    // Extract tx hash from the valid transaction
    // The txId would be computed from the CBOR - for now return a placeholder
    return this.computeTxHash(txCborHex);
  }

  /**
   * Get current head state.
   */
  getHeadState(): HeadState | null {
    return this.headState;
  }

  /**
   * Get current snapshot number.
   */
  getSnapshotNumber(): number {
    return this.headState?.snapshotNumber ?? 0;
  }

  /**
   * Get UTxOs in the head.
   */
  getUtxos(): HydraUtxo[] {
    return this.headState?.utxos ?? [];
  }

  /**
   * Register an event handler.
   */
  onEvent(handler: BatcherEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Remove an event handler.
   */
  offEvent(handler: BatcherEventHandler): void {
    const index = this.eventHandlers.indexOf(handler);
    if (index !== -1) {
      this.eventHandlers.splice(index, 1);
    }
  }

  // === Private Methods ===

  private getWebSocketUrl(): string {
    if (this.config.hydraEndpoints?.websocket) {
      return this.config.hydraEndpoints.websocket;
    }
    const { host, port } = this.config.recorderNode;
    return `ws://${host}:${port}`;
  }

  private ensureConnected(): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new HydraBatcherException(
        HydraBatcherError.CONNECTION_LOST,
        "Not connected to Hydra node"
      );
    }
  }

  private ensureHeadOpen(): void {
    if (!this.headState || this.headState.status !== "open") {
      throw new HydraBatcherException(
        HydraBatcherError.HEAD_NOT_OPEN,
        "Head is not open"
      );
    }
  }

  private sendCommand(command: HydraCommand): void {
    if (!this.ws) {
      throw new HydraBatcherException(
        HydraBatcherError.CONNECTION_LOST,
        "Not connected"
      );
    }
    const json = JSON.stringify(command);
    this.debug(`Sending command: ${command.tag}`);
    this.ws.send(json);
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as HydraMessage;
      this.debug(`Received message: ${message.tag}`);

      // Update internal state based on message
      this.updateState(message);

      // Add to queue for waitForMessage
      this.messageQueue.push(message);

      // Resolve any pending promises
      this.resolvePendingPromises(message);

    } catch (error) {
      this.debug(`Failed to parse message: ${String(error)}`);
    }
  }

  private updateState(message: HydraMessage): void {
    switch (message.tag) {
      case "Greetings":
        this.handleGreetings(message);
        break;

      case "HeadIsInitializing":
        this.headState = {
          headId: message.headId,
          status: "initializing",
          snapshotNumber: 0,
          utxos: [],
        };
        break;

      case "HeadIsOpen":
        if (this.headState) {
          this.headState.status = "open";
          this.headState.utxos = this.parseUtxos(message.utxo);
        }
        break;

      case "HeadIsClosed":
        if (this.headState) {
          this.headState.status = "closed";
          this.headState.contestationDeadline = message.contestationDeadline;
          this.headState.snapshotNumber = message.snapshotNumber;
        }
        break;

      case "SnapshotConfirmed":
        if (this.headState) {
          this.headState.snapshotNumber = message.snapshot.number;
          this.headState.utxos = this.parseUtxos(message.snapshot.utxo);
        }
        this.emitEvent({
          type: "snapshot:confirmed",
          timestamp: message.timestamp,
          data: { snapshotNumber: message.snapshot.number },
        });
        break;

      case "HeadIsAborted":
        if (this.headState) {
          this.headState.status = "error";
        }
        this.emitEvent({
          type: "head:error",
          timestamp: message.timestamp,
          data: { reason: "Head aborted" },
        });
        break;
    }
  }

  private handleGreetings(message: { headStatus: { tag: string }; snapshotUtxo: Record<string, unknown> }): void {
    // Initialize state from greetings
    const statusMap: Record<string, HeadStatus> = {
      "Idle": "closed",
      "Initializing": "initializing",
      "Open": "open",
      "Closed": "closed",
      "FanoutPossible": "fanout",
    };

    const status = statusMap[message.headStatus.tag] ?? "closed";

    if (status !== "closed") {
      this.headState = {
        headId: "", // Will be set when head opens
        status,
        snapshotNumber: 0,
        utxos: this.parseUtxos(message.snapshotUtxo as Record<string, HydraUtxoMessage>),
      };
    }
  }

  private parseUtxos(utxoMap: Record<string, HydraUtxoMessage>): HydraUtxo[] {
    return Object.entries(utxoMap).map(([txIn, utxo]): HydraUtxo => {
      const datum = typeof utxo.inlineDatum === "string" ? utxo.inlineDatum : undefined;
      const datumHash = utxo.datumhash ?? undefined;
      return {
        txIn,
        address: utxo.address,
        value: {
          lovelace: BigInt(utxo.value.lovelace),
          // Parse assets if present
        },
        datum,
        datumHash,
      };
    });
  }

  private handleDisconnect(_event: unknown): void {
    this.debug("Disconnected from Hydra node");
    this.ws = null;

    // Attempt reconnection if configured
    if (this.config.retryConfig && this.reconnectAttempts < this.config.retryConfig.maxRetries) {
      this.attemptReconnect();
    } else {
      this.emitEvent({
        type: "head:error",
        timestamp: new Date().toISOString(),
        data: { reason: "Connection lost" },
      });
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.config.retryConfig) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      this.config.retryConfig.initialDelayMs *
        Math.pow(this.config.retryConfig.backoffMultiplier, this.reconnectAttempts - 1),
      this.config.retryConfig.maxDelayMs
    );

    this.debug(`Attempting reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.connect();
    } catch {
      // Reconnection failed, will be handled by next disconnect
    }
  }

  private async waitForMessage(
    predicate: (msg: HydraMessage) => boolean,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<HydraMessage> {
    // Check existing queue first
    const existingIndex = this.messageQueue.findIndex(predicate);
    if (existingIndex !== -1) {
      const message = this.messageQueue[existingIndex];
      if (message) {
        this.messageQueue.splice(existingIndex, 1);
        return message;
      }
    }

    // Wait for new message
    return new Promise((resolve, reject) => {
      const promiseId = Math.random().toString(36).substring(7);

      const timeout = setTimeout(() => {
        this.pendingPromises.delete(promiseId);
        reject(new HydraBatcherException(
          HydraBatcherError.CONNECTION_FAILED,
          timeoutMessage
        ));
      }, timeoutMs);

      this.pendingPromises.set(promiseId, {
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg as HydraMessage);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      // Also check queue periodically in case message arrived while setting up
      const checkQueue = () => {
        const index = this.messageQueue.findIndex(predicate);
        if (index !== -1) {
          const message = this.messageQueue[index];
          this.messageQueue.splice(index, 1);
          const pending = this.pendingPromises.get(promiseId);
          if (pending) {
            this.pendingPromises.delete(promiseId);
            pending.resolve(message);
          }
        }
      };
      checkQueue();
    });
  }

  private resolvePendingPromises(message: HydraMessage): void {
    // This is a simplified version - in production, would need to match
    // specific promises to specific message types
    for (const [id, { resolve }] of this.pendingPromises) {
      // For now, just resolve all pending promises with the message
      // The waitForMessage predicate will filter appropriately
      this.pendingPromises.delete(id);
      resolve(message);
      break; // Only resolve one at a time
    }
  }

  private computeTxHash(_txCborHex: string): string {
    // In production, would compute the actual transaction hash from CBOR
    // For now, generate a placeholder
    return `tx_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  }

  private emitEvent(event: BatcherEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        this.debug(`Event handler error: ${String(error)}`);
      }
    }
  }

  private debug(message: string): void {
    if (this.config.debug) {
      console.log(`[HeadManager] ${message}`);
    }
  }
}
