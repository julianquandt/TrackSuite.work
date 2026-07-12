export interface TrayBridge {
    setTrackingState(isTracking: boolean): Promise<void>;
    showMainWindow(): Promise<void>;
}

export interface NotificationBridge {
    show(title: string, body: string): Promise<void>;
}

export interface PowerEventsBridge {
    onPrepareForSleep(callback: () => Promise<void> | void): Promise<void>;
}

export interface AutostartBridge {
    isEnabled(): Promise<boolean>;
    enable(): Promise<void>;
    disable(): Promise<void>;
}