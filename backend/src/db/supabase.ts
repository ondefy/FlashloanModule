import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';

let _client: SupabaseClient | null = null;

/**
 * Get the Supabase client (service_role — bypasses RLS).
 * Use this for ALL backend operations.
 */
export function getSupabase(): SupabaseClient {
  if (!_client) {
    const env = getEnv();
    _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return _client;
}

// ─── User operations ────────────────────────────────────────────────────────

export async function upsertUser(address: string) {
  const supabase = getSupabase();
  const addr = address.toLowerCase();

  const { error } = await supabase
    .from('users')
    .upsert(
      { address: addr, updated_at: new Date().toISOString() },
      { onConflict: 'address' }
    );

  if (error) throw new Error(`Failed to upsert user: ${error.message}`);
}

export async function getUser(address: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('address', address.toLowerCase())
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to get user: ${error.message}`);
  }
  return data;
}

export async function updateOnboardingStep(address: string, step: number) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('users')
    .update({ onboarding_step: step, updated_at: new Date().toISOString() })
    .eq('address', address.toLowerCase());

  if (error) throw new Error(`Failed to update onboarding step: ${error.message}`);
}

export async function setSafeAddress(userAddress: string, safeAddress: string) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('users')
    .update({
      safe_address: safeAddress.toLowerCase(),
      updated_at: new Date().toISOString(),
    })
    .eq('address', userAddress.toLowerCase());

  if (error) throw new Error(`Failed to set safe address: ${error.message}`);
}

// ─── Session key operations ─────────────────────────────────────────────────

export async function saveSessionKey(
  userAddress: string,
  keyAddress: string,
  encryptedKey: string, // JSON blob from crypto service
) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('session_keys')
    .upsert({
      user_address: userAddress.toLowerCase(),
      key_address: keyAddress.toLowerCase(),
      encrypted_key: JSON.parse(encryptedKey),
      is_active: true,
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_address' });

  if (error) throw new Error(`Failed to save session key: ${error.message}`);
}

export async function getSessionKey(userAddress: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('session_keys')
    .select('encrypted_key, key_address, is_active')
    .eq('user_address', userAddress.toLowerCase())
    .eq('is_active', true)
    .single();

  if (error) throw new Error(`Failed to get session key: ${error.message}`);
  return data;
}

// ─── Transaction log operations ─────────────────────────────────────────────

export interface TransactionLogInsert {
  user_address: string;
  position_id?: string;
  safe_address?: string;
  tx_type: string;
  protocol?: string;
  token_address?: string;
  amount?: string;
  amount_usd?: string;
  tx_hash?: string;
  user_op_hash?: string;
  block_number?: number;
  status: string;
  error_message?: string;
  metadata?: Record<string, unknown>;
}

export async function insertTransactionLog(log: TransactionLogInsert) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('transaction_logs')
    .insert({
      ...log,
      user_address: log.user_address.toLowerCase(),
      safe_address: log.safe_address?.toLowerCase(),
      token_address: log.token_address?.toLowerCase(),
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to insert transaction log: ${error.message}`);
  return data.id;
}

export async function updateTransactionLog(
  id: string,
  updates: { status?: string; tx_hash?: string; user_op_hash?: string; block_number?: number; error_message?: string },
) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('transaction_logs')
    .update(updates)
    .eq('id', id);

  if (error) throw new Error(`Failed to update transaction log: ${error.message}`);
}

export async function getTransactionLogs(userAddress: string, limit = 50, offset = 0) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('v_transaction_logs')
    .select('*')
    .eq('user_address', userAddress.toLowerCase())
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Failed to get transaction logs: ${error.message}`);
  return data;
}

// ─── Position operations ────────────────────────────────────────────────────

export interface PositionInsert {
  user_address: string;
  safe_address: string;
  current_protocol: string;
  collateral_token: string;
  collateral_amount: string;
  debt_token: string;
  debt_amount: string;
  health_factor?: number;
  morpho_market_id?: string;
}

export async function insertPosition(position: PositionInsert) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('positions')
    .insert({
      ...position,
      user_address: position.user_address.toLowerCase(),
      safe_address: position.safe_address.toLowerCase(),
      collateral_token: position.collateral_token.toLowerCase(),
      debt_token: position.debt_token.toLowerCase(),
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to insert position: ${error.message}`);
  return data.id;
}

export async function getActivePositions(userAddress: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('v_positions_detail')
    .select('*')
    .eq('user_address', userAddress.toLowerCase())
    .eq('status', 'active');

  if (error) throw new Error(`Failed to get positions: ${error.message}`);
  return data;
}

export async function getPositionsDueForCheck(limit = 500) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('v_positions_due_check')
    .select('*')
    .limit(limit);

  if (error) throw new Error(`Failed to get positions due for check: ${error.message}`);
  return data;
}

export async function updatePositionHealth(
  positionId: string,
  healthFactor: number,
  collateralAmount: string,
  debtAmount: string,
  supplyApy?: number,
  borrowApy?: number,
) {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('update_position_health', {
    p_id: positionId,
    p_health_factor: healthFactor,
    p_collateral_amount: collateralAmount,
    p_debt_amount: debtAmount,
    p_supply_apy: supplyApy ?? null,
    p_borrow_apy: borrowApy ?? null,
  });

  if (error) throw new Error(`Failed to update position health: ${error.message}`);
}

export async function updatePositionProtocol(
  positionId: string,
  newProtocol: string,
) {
  const supabase = getSupabase();

  // Fetch current migration count, then increment
  const { data: current } = await supabase
    .from('positions')
    .select('migration_count')
    .eq('id', positionId)
    .single();

  const newCount = (current?.migration_count ?? 0) + 1;

  const { error } = await supabase
    .from('positions')
    .update({
      current_protocol: newProtocol,
      migration_count: newCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', positionId);

  if (error) throw new Error(`Failed to update position protocol: ${error.message}`);
}
