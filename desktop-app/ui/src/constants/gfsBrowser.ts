export const GFS_BREADCRUMB_MAX_DEPTH = 64

/** Cache identity for discovery requests that use the server's default drive. */
export const GFS_DEFAULT_DISCOVERY_DRIVE = 'main'

/** Internal EvenDrive drag payload type, shared by the Files page and the
 * sidebar file explorer. Carries the resourceId as an identity POINTER only:
 * handlers never derive authority or copy from payload data — the active
 * in-window drag descriptor is the source of identity (rev-2 §4). */
export const GFS_RESOURCE_DRAG_TYPE = 'application/x-evenfire-gfs-resource'

/** Hovering a collapsed folder for this long expands it through its existing
 * loader; canceled on leave/drop/drag end (rev-2 §4.1). */
export const FOLDER_HOVER_EXPAND_DELAY_MS = 600

/** A cold hover target is checked only after this dwell, so sweeping the tree
 * does not spend feature requests (rev-2 §4.1). */
export const DRAG_COLD_CHECK_DEBOUNCE_MS = 150

/** At most this many NEW cold destination checks per drag; beyond it targets
 * stay "checking" and receive a priority check on drop (rev-2 §4.1). */
export const DRAG_COLD_CHECK_BUDGET = 8

/** Concurrent cold-hover probe chains per gesture, shared across both surfaces. */
export const DRAG_COLD_CHECK_MAX_CONCURRENCY = 2

/** Label of the caller's own home wherever EvenDrive shows it as a root. */
export const GFS_MY_HOME_LABEL = 'My home'

/** Label of the collection of resources others share with the caller. */
export const GFS_SHARED_WITH_ME_LABEL = 'Shared with me'

/**
 * Files-tab location of the "Shared with me" view. A `null` location is the
 * EvenDrive overview (the caller's home plus what others share); this one
 * lists only what others share. It is a client view id, never a `gfs://` URI,
 * so it is never resolved against the server.
 */
export const GFS_SHARED_WITH_ME_LOCATION = 'evendrive:shared-with-me'

/** Client-only location for the dedicated Recent files tab. */
export const GFS_RECENT_FILES_LOCATION = 'evendrive:recent-files'

/** Maximum number of files shown in the EvenDrive overview. */
export const GFS_RECENT_FILES_VISIBLE_LIMIT = 5

/** The overview card's heading and accessible region name (D11). */
export const GFS_RECENT_FILES_LABEL = 'Recent files'
