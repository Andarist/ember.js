/**
  @module @ember/routing/location
*/

/**
  `Location` defines an interface to be implemented by `location` APIs. It is
  not user-constructible; the only valid way to get a `Location` is via one of
  its concrete implementations.

  ## Implementations

  You can pass an implementation name (`hash`, `history`, `none`) to force a
  particular implementation to be used in your application.

  See [HashLocation](/ember/release/classes/HashLocation).
  See [HistoryLocation](/ember/release/classes/HistoryLocation).
  See [NoneLocation](/ember/release/classes/NoneLocation).

  ## Location API

  Each location implementation must provide the following methods:

  * implementation: returns the string name used to reference the implementation.
  * getURL: returns the current URL.
  * setURL(path): sets the current URL.
  * replaceURL(path): replace the current URL (optional).
  * onUpdateURL(callback): triggers the callback when the URL changes.
  * formatURL(url): formats `url` to be placed into `href` attribute.
  * detect() (optional): instructs the location to do any feature detection
      necessary. If the location needs to redirect to a different URL, it
      can cancel routing by setting the `cancelRouterSetup` property on itself
      to `false`.

  Calling setURL or replaceURL will not trigger onUpdateURL callbacks.

  ## Custom implementation

  Ember scans `app/locations/*` for extending the Location API.

  Example:

  ```javascript
  import HistoryLocation from '@ember/routing/history-location';

  export default class MyHistory {
    implementation = 'my-custom-history';

    constructor() {
      this._history = HistoryLocation.create(...arguments);
    }

    create() {
      return new this(...arguments);
    }

    pushState(path) {
       this._history.pushState(path);
    }
  }
  ```

  @class Location
  @private
*/
export interface ILocation {
  implementation: string;
  cancelRouterSetup?: boolean;
  getURL(): string;
  setURL(url: string): void;
  replaceURL?(url: string): void;
  onUpdateURL(callback: UpdateCallback): void;
  formatURL(url: string): string;
  detect?(): void;
  initState?(): void;
  destroy(): void;
}

export type UpdateCallback = (url: string) => void;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Registry extends Record<string, ILocation | undefined> {}

declare module '@ember/owner' {
  export interface DIRegistry {
    location: Registry;
  }
}

const Location = {};
export default Location;
