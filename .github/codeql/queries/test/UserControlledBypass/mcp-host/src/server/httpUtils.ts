export function json(res: any, status: number, body: unknown): void {
  res.status(status).json(body);
}
