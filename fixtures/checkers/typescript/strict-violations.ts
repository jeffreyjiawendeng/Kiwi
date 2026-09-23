interface Point {
  x: number;
  y?: number;
}

const values: number[] = [1, 2, 3];

export const first: number = values[0];

export const point: Point = { x: 1, y: undefined };
