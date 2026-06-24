export interface User {
  id: string;
  name: string;
  avatar: string;
  email: string;
  role: 'student' | 'lecturer' | 'admin';
  major: string;
  class?: string;
  points: number;
  badges: Badge[];
  selectedBadgeId?: string;
  followers: number;
  following: number;
  postsCount: number;
  joinedDate: string;
}

export interface Badge {
  id: string;
  name: string;
  icon: string;
  description: string;
  requiredPoints: number;
  color: string;
}
