// A real user's rows are booked under their email (frontend users, contractors, the admin including its mirrored shares). A strategy runs under
// its instance id (the block's userId or type), which never is an email.
export const isRealUser = (user: unknown): boolean => String(user ?? '').includes('@');
