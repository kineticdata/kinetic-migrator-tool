export interface ApiErrorBody {
    error: {
        code: string;
        message: string;
        detail?: unknown;
    };
}
export interface SessionInfo {
    version: string;
    workspace: string;
    keychain: {
        available: boolean;
    };
}
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface JobEventData {
    type: string;
    [field: string]: unknown;
}
export interface JobEvent {
    seq: number;
    at: string;
    type: string;
    data: JobEventData;
}
export interface JobInfo<R = unknown> {
    id: string;
    kind: string;
    status: JobStatus;
    createdAt: string;
    finishedAt?: string;
    result?: R;
    error?: {
        code: string;
        message: string;
    };
}
export interface JobEndEvent {
    status: JobStatus;
}
export interface JobStarted {
    jobId: string;
}
