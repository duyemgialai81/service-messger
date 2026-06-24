export const STORAGE_KEYS = {
  USER: "ksp_user",
  AUTH_TOKEN: "ksp_auth_token",
  DEVICE_ID: "ksp_device_id",
  FAVORITES: "ksp_favorites",
  POSTS: "ksp_posts",
  FILTERS: "ksp_filters",
  THEME: "ksp_theme"
};

let inMemoryAuthToken: string | null = null;

if (typeof window !== "undefined") {
  localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.removeItem(STORAGE_KEYS.POSTS);
}

export const localStorage_service = {
  saveUser: (_user: any) => {
    localStorage.removeItem(STORAGE_KEYS.USER);
  },
  getUser: () => {
    localStorage.removeItem(STORAGE_KEYS.USER);
    return null;
  },
  removeUser: () => {
    localStorage.removeItem(STORAGE_KEYS.USER);
  },
  saveAuthToken: (token: string) => {
    localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    inMemoryAuthToken = token && token.split(".").length === 3 ? token : null;
  },
  getAuthToken: () => {
    if (!inMemoryAuthToken) return null;
    if (inMemoryAuthToken.split(".").length !== 3) {
      inMemoryAuthToken = null;
      return null;
    }
    return inMemoryAuthToken;
  },
  removeAuthToken: () => {
    localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    inMemoryAuthToken = null;
  },
  saveDeviceId: (id: string) => {
    localStorage.setItem(STORAGE_KEYS.DEVICE_ID, id);
  },
  getDeviceId: () => {
    return localStorage.getItem(STORAGE_KEYS.DEVICE_ID);
  },
  saveFavorites: (favorites: string[]) => {
    localStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(favorites));
  },
  getFavorites: () => {
    const favorites = localStorage.getItem(STORAGE_KEYS.FAVORITES);
    return favorites ? JSON.parse(favorites) : [];
  },
  addFavorite: (postId: string) => {
    const favorites = localStorage_service.getFavorites();
    if (!favorites.includes(postId)) {
      favorites.push(postId);
      localStorage_service.saveFavorites(favorites);
    }
  },
  removeFavorite: (postId: string) => {
    const favorites = localStorage_service.getFavorites();
    localStorage_service.saveFavorites(favorites.filter((id: string) => id !== postId));
  },
  savePosts: (_posts: any[]) => {
    localStorage.removeItem(STORAGE_KEYS.POSTS);
  },
  getPosts: () => {
    localStorage.removeItem(STORAGE_KEYS.POSTS);
    return [];
  },
  saveFilters: (filters: any) => {
    localStorage.setItem(STORAGE_KEYS.FILTERS, JSON.stringify(filters));
  },
  getFilters: () => {
    const filters = localStorage.getItem(STORAGE_KEYS.FILTERS);
    return filters ? JSON.parse(filters) : null;
  },
  saveTheme: (theme: string) => {
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  },
  getTheme: () => {
    return localStorage.getItem(STORAGE_KEYS.THEME) || "light";
  },
  clearAll: () => {
    localStorage.clear();
    inMemoryAuthToken = null;
  }
};
