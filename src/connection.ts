import { ethers } from "ethers";
import { sendEmailAlert } from "./utils";

export class RobustProvider {
    private urls: string[]; // Store all available nodes
    private currentUrlIndex: number = 0; // [Added] Index of the current node being used
    private provider: ethers.WebSocketProvider | ethers.JsonRpcProvider;
    private pingInterval: NodeJS.Timeout | null = null;
    private reconnectCallback: () => void;
    
    // Constructor accepts an array of URLs
    constructor(urls: string[], onReconnect: () => void) {
        if (urls.length === 0) throw new Error("No RPC URLs provided");
        this.urls = urls;
        this.reconnectCallback = onReconnect;
        
        // Initialize the first node
        this.provider = this.initProvider(this.urls[0]);
    }

    // Initialize with a specific URL
    private initProvider(url: string) {
        const isWs = url.startsWith("ws");
        console.log(`[Network] Initializing Provider: ${url} (Type: ${isWs ? 'WS' : 'HTTP'})...`);

        if (isWs) {
            const provider = new ethers.WebSocketProvider(url);

            // Error Handling
            provider.websocket.onerror = (error: any) => {
                console.error("[Network] WebSocket Error:", error);
                this.triggerNextProvider(); // [Modified] Switch node on error
            };

            // Close Handling
            (provider.websocket as any).onclose = (code: any) => {
                console.warn(
                    `[Network] WebSocket Closed (Code: ${code}). Switching node...`
                );
                this.triggerNextProvider();
            };

            // Heartbeat: Keep the connection alive
            this.startHeartbeat(provider);

            return provider;
        } else {
            console.log(`[Network] Initializing HTTP Provider...`);
            // HTTP Providers don't have connection close events like WS, usually relying on request timeouts.
            // However, ethers.JsonRpcProvider handles some retries internally.
            // Here we mainly rely on the reconnection mechanism triggered by external call errors.
            return new ethers.JsonRpcProvider(url);
        }
    }

    private startHeartbeat(provider: ethers.WebSocketProvider) {
        if (this.pingInterval) clearInterval(this.pingInterval);

        // Ping every 30 seconds
        this.pingInterval = setInterval(async () => {
            try {
                await provider.getBlockNumber();
            } catch (e) {
                console.error("[Network] Heartbeat failed. Switching node...");
                this.triggerNextProvider();
            }
        }, 30000);
    }

    // Switch to the next node and reconnect
    public async triggerNextProvider() {
        if (this.pingInterval) clearInterval(this.pingInterval);

        // Prevent rapid switching in a short period (e.g., if all nodes are down)
        await new Promise((r) => setTimeout(r, 2000));

        // Round-robin algorithm: Index + 1 modulo length
        this.currentUrlIndex = (this.currentUrlIndex + 1) % this.urls.length;
        const nextUrl = this.urls[this.currentUrlIndex];

        console.log(`[Network] Switching to next RPC node [${this.currentUrlIndex + 1}/${this.urls.length}]: ${nextUrl}`);
        sendEmailAlert(`[Network] switching`, `switch to ${nextUrl}`)

        // Destroy old connection (if WS)
        if (this.provider instanceof ethers.WebSocketProvider) {
            try {
                await this.provider.destroy(); 
            } catch (e) { /* ignore */ }
        }

        this.provider = this.initProvider(nextUrl);
        this.reconnectCallback(); // Notify upper layer to re-bind events
    }

    public getProvider() {
        return this.provider;
    }
}