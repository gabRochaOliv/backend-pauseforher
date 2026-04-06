import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não estão configuradas corretamente.');
}

// Inicializamos o cliente usando a Service Role Key para desviar do RLS (Row Level Security),
// já que o webhook precisa de permissões totais para alterar o status do plano de qualquer usuário.
export const supabase = createClient(supabaseUrl, supabaseServiceKey);
