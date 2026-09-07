const INTERCEPTED_EVENT = 'share-this-tweet:intercepted';

// The page-world adapter will intercept X responses in a later slice.
// Keep the event name local and stable so content-script plumbing can evolve
// without coupling the UI to X's DOM or visible language.
void INTERCEPTED_EVENT;
