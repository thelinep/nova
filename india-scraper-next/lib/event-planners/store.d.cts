export type Planner = {id:string;name:string;category:string|null;phone:string|null;website:string|null;address:string|null;rating:string|null;reviews:string|null;latitude:number|null;longitude:number|null;maps_url:string;last_seen:string;discoveredIn:{district:string;state:string;status:string}[]};
export type PlannerResults = {total:number;limit:number;offset:number;hasMore:boolean;records:Planner[]};
export type CollectionSummary = {runnerState:string;totalDistricts:number;uniqueBusinesses:number;lastProgressAt?:string;pauseReason?:string;lastError?:string;districtSnapshotAt:string;counts:{status:string;count:number;listings:number}[];states:{state:string;total:number;attempted:number}[];active:{district:string;state:string;started_at:string}[]};
export function readSummary():Promise<CollectionSummary>;
export function search(params:URLSearchParams):Promise<PlannerResults>;
