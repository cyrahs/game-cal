export interface CalendarEvent {
  id: string | number;
  title: string;
  start_time: string;
  end_time: string;
  banner?: string;
  content?: string;
  linkUrl?: string;
  isEnd?: boolean;
}

export interface CalendarBar extends CalendarEvent {
  color: string;
  level: number;
  left: number;
  width: number;
}

