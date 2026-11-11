import { Store } from 'mppx/server';
export declare class MppxStore extends Store.DurableObjectStore {
}
type Env = {
    /** Durable Object namespace of {@link MppxStore}. */
    MPPX_STORE: Store.durableObject.Namespace;
    /** Payee account key: receives payments. */
    MPP_PRIVATE_KEY: string;
    /** Secret that binds challenge IDs, so they verify statelessly. */
    MPP_SECRET_KEY: string;
    /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
    TEMPO_RPC_URL?: string | undefined;
};
declare const _default: {
    fetch(request: Request, env: Env): Promise<Response>;
};
export default _default;
