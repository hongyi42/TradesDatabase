export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      access_grants: {
        Row: {
          created_at: string
          customer_id: string | null
          expires_at: string | null
          granted_by: string
          id: string
          job_id: string | null
          opens: string
          opens_money: boolean
          reason: string
          requested_by: string | null
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          technician_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          expires_at?: string | null
          granted_by: string
          id?: string
          job_id?: string | null
          opens: string
          opens_money?: boolean
          reason: string
          requested_by?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          technician_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          expires_at?: string | null
          granted_by?: string
          id?: string
          job_id?: string | null
          opens?: string
          opens_money?: boolean
          reason?: string
          requested_by?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          technician_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "access_grants_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_grants_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "access_grants_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_grants_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "access_grants_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_money_events"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "access_grants_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "access_grants_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_grants_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "access_grants_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_grants_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "access_grants_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_grants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_ingest: {
        Row: {
          attempts: number
          audio_delete_after: string | null
          audio_deleted_at: string | null
          audio_ref: string | null
          call_sid: string | null
          caller_phone: string | null
          capture_id: string | null
          consent_announced: boolean
          created_at: string
          external_id: string
          id: string
          last_error: string | null
          legal_hold: boolean
          match_status: string | null
          occurred_at: string | null
          payload: Json
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          audio_delete_after?: string | null
          audio_deleted_at?: string | null
          audio_ref?: string | null
          call_sid?: string | null
          caller_phone?: string | null
          capture_id?: string | null
          consent_announced?: boolean
          created_at?: string
          external_id: string
          id?: string
          last_error?: string | null
          legal_hold?: boolean
          match_status?: string | null
          occurred_at?: string | null
          payload?: Json
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          audio_delete_after?: string | null
          audio_deleted_at?: string | null
          audio_ref?: string | null
          call_sid?: string | null
          caller_phone?: string | null
          capture_id?: string | null
          consent_announced?: boolean
          created_at?: string
          external_id?: string
          id?: string
          last_error?: string | null
          legal_hold?: boolean
          match_status?: string | null
          occurred_at?: string | null
          payload?: Json
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_ingest_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_ingest_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_ingest_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      call_numbers: {
        Row: {
          created_at: string
          forward_to: string | null
          id: string
          phone_number: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          forward_to?: string | null
          id?: string
          phone_number: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          forward_to?: string | null
          id?: string
          phone_number?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_numbers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      capture_tags: {
        Row: {
          capture_id: string
          created_at: string
          reason: string | null
          source: string
          tag: string
          tenant_id: string
        }
        Insert: {
          capture_id: string
          created_at?: string
          reason?: string | null
          source: string
          tag: string
          tenant_id: string
        }
        Update: {
          capture_id?: string
          created_at?: string
          reason?: string | null
          source?: string
          tag?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "capture_tags_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capture_tags_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capture_tags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_events: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          method: string
          occurred_at: string
          provider: string
          quantity: number
          sku: string
          source_ref: string | null
          technician_ref: string | null
          tenant_id: string
          unit: string
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json | null
          method: string
          occurred_at?: string
          provider: string
          quantity: number
          sku: string
          source_ref?: string | null
          technician_ref?: string | null
          tenant_id: string
          unit: string
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          method?: string
          occurred_at?: string
          provider?: string
          quantity?: number
          sku?: string
          source_ref?: string | null
          technician_ref?: string | null
          tenant_id?: string
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_rates: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          provider: string
          sku: string
          source_url: string | null
          unit: string
          unit_cost_usd: number
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          id?: string
          provider: string
          sku: string
          source_url?: string | null
          unit: string
          unit_cost_usd: number
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          provider?: string
          sku?: string
          source_url?: string | null
          unit?: string
          unit_cost_usd?: number
        }
        Relationships: []
      }
      cost_rollup_monthly: {
        Row: {
          computed_at: string
          cost_usd: number
          method: string
          period_start: string
          provider: string
          quantity: number
          tenant_id: string
        }
        Insert: {
          computed_at?: string
          cost_usd?: number
          method: string
          period_start: string
          provider: string
          quantity?: number
          tenant_id: string
        }
        Update: {
          computed_at?: string
          cost_usd?: number
          method?: string
          period_start?: string
          provider?: string
          quantity?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_rollup_monthly_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_captures: {
        Row: {
          capture_id: string
          created_at: string
          customer_id: string
          tenant_id: string
        }
        Insert: {
          capture_id: string
          created_at?: string
          customer_id: string
          tenant_id: string
        }
        Update: {
          capture_id?: string
          created_at?: string
          customer_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_captures_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_captures_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "customer_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "customer_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_money_events"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "customer_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "customer_captures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          attributes: Json
          city: string | null
          created_at: string
          email: string | null
          geocoded_at: string | null
          id: string
          lat: number | null
          lng: number | null
          name: string
          phone: string | null
          phone_key: string | null
          postal_code: string | null
          source_capture_id: string | null
          state: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          attributes?: Json
          city?: string | null
          created_at?: string
          email?: string | null
          geocoded_at?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
          phone?: string | null
          phone_key?: string | null
          postal_code?: string | null
          source_capture_id?: string | null
          state?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          attributes?: Json
          city?: string | null
          created_at?: string
          email?: string | null
          geocoded_at?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
          phone?: string | null
          phone_key?: string | null
          postal_code?: string | null
          source_capture_id?: string | null
          state?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_source_capture_fk"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_source_capture_fk"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      dropped_audit: {
        Row: {
          channel: Database["public"]["Enums"]["capture_channel"]
          classifier_reason: string | null
          dropped_at: string
          expires_at: string
          external_id: string | null
          id: string
          sender_domain: string | null
          technician_ref: string | null
          tenant_id: string
        }
        Insert: {
          channel: Database["public"]["Enums"]["capture_channel"]
          classifier_reason?: string | null
          dropped_at?: string
          expires_at?: string
          external_id?: string | null
          id?: string
          sender_domain?: string | null
          technician_ref?: string | null
          tenant_id: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["capture_channel"]
          classifier_reason?: string | null
          dropped_at?: string
          expires_at?: string
          external_id?: string | null
          id?: string
          sender_domain?: string | null
          technician_ref?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dropped_audit_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      host_metrics: {
        Row: {
          cpu_cores: number | null
          cpu_usage_usec: number | null
          disk_used_pct: number | null
          host_id: string
          load5: number | null
          mem_avail_mb: number | null
          mem_total_mb: number | null
          observed_at: string
          oom_kills: number | null
          psi_cpu_some_us: number | null
          psi_mem_full_us: number | null
          psi_mem_some_us: number | null
          sandboxes: Json
          seats: number | null
        }
        Insert: {
          cpu_cores?: number | null
          cpu_usage_usec?: number | null
          disk_used_pct?: number | null
          host_id: string
          load5?: number | null
          mem_avail_mb?: number | null
          mem_total_mb?: number | null
          observed_at: string
          oom_kills?: number | null
          psi_cpu_some_us?: number | null
          psi_mem_full_us?: number | null
          psi_mem_some_us?: number | null
          sandboxes?: Json
          seats?: number | null
        }
        Update: {
          cpu_cores?: number | null
          cpu_usage_usec?: number | null
          disk_used_pct?: number | null
          host_id?: string
          load5?: number | null
          mem_avail_mb?: number | null
          mem_total_mb?: number | null
          observed_at?: string
          oom_kills?: number | null
          psi_cpu_some_us?: number | null
          psi_mem_full_us?: number | null
          psi_mem_some_us?: number | null
          sandboxes?: Json
          seats?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "host_metrics_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "hosts"
            referencedColumns: ["id"]
          },
        ]
      }
      hosts: {
        Row: {
          created_at: string
          id: string
          name: string
          token_hash: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          token_hash: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          token_hash?: string
        }
        Relationships: []
      }
      infra_costs: {
        Row: {
          allocation: string
          amount_usd: number
          created_at: string
          id: string
          item: string
          period_end: string
          period_start: string
          source: string
          updated_at: string
          vendor: string
        }
        Insert: {
          allocation: string
          amount_usd: number
          created_at?: string
          id?: string
          item: string
          period_end: string
          period_start: string
          source?: string
          updated_at?: string
          vendor: string
        }
        Update: {
          allocation?: string
          amount_usd?: number
          created_at?: string
          id?: string
          item?: string
          period_end?: string
          period_start?: string
          source?: string
          updated_at?: string
          vendor?: string
        }
        Relationships: []
      }
      job_captures: {
        Row: {
          capture_id: string
          created_at: string
          job_id: string
          tenant_id: string
        }
        Insert: {
          capture_id: string
          created_at?: string
          job_id: string
          tenant_id: string
        }
        Update: {
          capture_id?: string
          created_at?: string
          job_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_captures_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_captures_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "job_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "job_captures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      job_note_versions: {
        Row: {
          content: string
          id: string
          job_id: string
          replaced_at: string
          tenant_id: string
        }
        Insert: {
          content: string
          id?: string
          job_id: string
          replaced_at?: string
          tenant_id: string
        }
        Update: {
          content?: string
          id?: string
          job_id?: string
          replaced_at?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_note_versions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_note_versions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "job_note_versions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_note_versions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "job_note_versions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      job_notes: {
        Row: {
          content: string
          created_at: string
          job_id: string
          tenant_id: string
          written_at: string
        }
        Insert: {
          content: string
          created_at?: string
          job_id: string
          tenant_id: string
          written_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          job_id?: string
          tenant_id?: string
          written_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_notes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "job_notes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "job_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      job_type_durations: {
        Row: {
          created_at: string
          id: string
          job_type: string
          minutes: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          job_type: string
          minutes: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          job_type?: string
          minutes?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_type_durations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          attributes: Json
          created_at: string
          customer_id: string
          duration_minutes: number | null
          id: string
          job_type: string | null
          price_cents: number | null
          priority: Database["public"]["Enums"]["job_priority"]
          source_capture_id: string | null
          status: Database["public"]["Enums"]["job_status"]
          tenant_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          attributes?: Json
          created_at?: string
          customer_id: string
          duration_minutes?: number | null
          id?: string
          job_type?: string | null
          price_cents?: number | null
          priority?: Database["public"]["Enums"]["job_priority"]
          source_capture_id?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          attributes?: Json
          created_at?: string
          customer_id?: string
          duration_minutes?: number | null
          id?: string
          job_type?: string | null
          price_cents?: number | null
          priority?: Database["public"]["Enums"]["job_priority"]
          source_capture_id?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          tenant_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_money_events"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "jobs_source_capture_fk"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_source_capture_fk"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      lifecycle_runs: {
        Row: {
          created_at: string
          finished_at: string
          id: string
          ok: boolean
          started_at: string
          summary: Json
        }
        Insert: {
          created_at?: string
          finished_at?: string
          id?: string
          ok: boolean
          started_at: string
          summary: Json
        }
        Update: {
          created_at?: string
          finished_at?: string
          id?: string
          ok?: boolean
          started_at?: string
          summary?: Json
        }
        Relationships: []
      }
      money_events: {
        Row: {
          actor_ref: string | null
          amount_cents: number | null
          corrects_event_id: number | null
          created_at: string
          currency: string
          dedupe_key: string | null
          detail: Json
          external_ref: string | null
          id: number
          job_id: string
          kind: Database["public"]["Enums"]["money_event_kind"]
          method: string | null
          occurred_at: string
          source_capture_id: string | null
          tenant_id: string
        }
        Insert: {
          actor_ref?: string | null
          amount_cents?: number | null
          corrects_event_id?: number | null
          created_at?: string
          currency?: string
          dedupe_key?: string | null
          detail?: Json
          external_ref?: string | null
          id?: never
          job_id: string
          kind: Database["public"]["Enums"]["money_event_kind"]
          method?: string | null
          occurred_at?: string
          source_capture_id?: string | null
          tenant_id: string
        }
        Update: {
          actor_ref?: string | null
          amount_cents?: number | null
          corrects_event_id?: number | null
          created_at?: string
          currency?: string
          dedupe_key?: string | null
          detail?: Json
          external_ref?: string | null
          id?: never
          job_id?: string
          kind?: Database["public"]["Enums"]["money_event_kind"]
          method?: string | null
          occurred_at?: string
          source_capture_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "money_events_corrects_event_id_fkey"
            columns: ["corrects_event_id"]
            isOneToOne: false
            referencedRelation: "money_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_corrects_event_id_fkey"
            columns: ["corrects_event_id"]
            isOneToOne: false
            referencedRelation: "v_money_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "money_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "money_events_source_capture_id_fkey"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_source_capture_id_fkey"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      nudge_decisions: {
        Row: {
          action: string
          agent_context: string | null
          basis: string | null
          citation: string | null
          confidence: string
          decided_at: string
          escalate_after: string | null
          handoff_note: string | null
          id: string
          job_id: string | null
          mode: string
          not_before: string | null
          nudge_id: string | null
          observation_id: string | null
          outcome: string
          outcome_detail: string | null
          question_draft: string | null
          reason: string
          tenant_id: string
          to_ref: string | null
          via: string | null
        }
        Insert: {
          action: string
          agent_context?: string | null
          basis?: string | null
          citation?: string | null
          confidence: string
          decided_at?: string
          escalate_after?: string | null
          handoff_note?: string | null
          id?: string
          job_id?: string | null
          mode: string
          not_before?: string | null
          nudge_id?: string | null
          observation_id?: string | null
          outcome: string
          outcome_detail?: string | null
          question_draft?: string | null
          reason?: string
          tenant_id: string
          to_ref?: string | null
          via?: string | null
        }
        Update: {
          action?: string
          agent_context?: string | null
          basis?: string | null
          citation?: string | null
          confidence?: string
          decided_at?: string
          escalate_after?: string | null
          handoff_note?: string | null
          id?: string
          job_id?: string | null
          mode?: string
          not_before?: string | null
          nudge_id?: string | null
          observation_id?: string | null
          outcome?: string
          outcome_detail?: string | null
          question_draft?: string | null
          reason?: string
          tenant_id?: string
          to_ref?: string | null
          via?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nudge_decisions_nudge_id_fkey"
            columns: ["nudge_id"]
            isOneToOne: false
            referencedRelation: "mv_escalation_fates"
            referencedColumns: ["nudge_id"]
          },
          {
            foreignKeyName: "nudge_decisions_nudge_id_fkey"
            columns: ["nudge_id"]
            isOneToOne: false
            referencedRelation: "mv_gap_outcomes"
            referencedColumns: ["nudge_id"]
          },
          {
            foreignKeyName: "nudge_decisions_nudge_id_fkey"
            columns: ["nudge_id"]
            isOneToOne: false
            referencedRelation: "nudges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudge_decisions_nudge_id_fkey"
            columns: ["nudge_id"]
            isOneToOne: false
            referencedRelation: "v_nudges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudge_decisions_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudge_decisions_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "v_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudge_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      nudges: {
        Row: {
          actor_ref: string
          answered_by_capture_id: string | null
          ask_group_id: string | null
          asked_at: string | null
          attempts: number
          context: Json
          created_at: string
          escalate_after: string | null
          id: string
          kind: string
          not_before: string | null
          prior_status: string | null
          question: string | null
          queued_at: string | null
          resolution: string | null
          resolved_at: string | null
          serve_count: number
          status: string
          subject_ref: string
          technician_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          actor_ref?: string
          answered_by_capture_id?: string | null
          ask_group_id?: string | null
          asked_at?: string | null
          attempts?: number
          context?: Json
          created_at?: string
          escalate_after?: string | null
          id?: string
          kind: string
          not_before?: string | null
          prior_status?: string | null
          question?: string | null
          queued_at?: string | null
          resolution?: string | null
          resolved_at?: string | null
          serve_count?: number
          status?: string
          subject_ref: string
          technician_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          actor_ref?: string
          answered_by_capture_id?: string | null
          ask_group_id?: string | null
          asked_at?: string | null
          attempts?: number
          context?: Json
          created_at?: string
          escalate_after?: string | null
          id?: string
          kind?: string
          not_before?: string | null
          prior_status?: string | null
          question?: string | null
          queued_at?: string | null
          resolution?: string | null
          resolved_at?: string | null
          serve_count?: number
          status?: string
          subject_ref?: string
          technician_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "nudges_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudges_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      observations: {
        Row: {
          asked_at: string | null
          author: string
          context: Json
          dismiss_reason: string | null
          dismissed_at: string | null
          id: string
          kind: string
          not_before: string | null
          noticed_at: string
          pinged_at: string | null
          status: string
          subject_ref: string
          technician_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          asked_at?: string | null
          author?: string
          context?: Json
          dismiss_reason?: string | null
          dismissed_at?: string | null
          id?: string
          kind: string
          not_before?: string | null
          noticed_at?: string
          pinged_at?: string | null
          status?: string
          subject_ref: string
          technician_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          asked_at?: string | null
          author?: string
          context?: Json
          dismiss_reason?: string | null
          dismissed_at?: string | null
          id?: string
          kind?: string
          not_before?: string | null
          noticed_at?: string
          pinged_at?: string | null
          status?: string
          subject_ref?: string
          technician_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "observations_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      office_messages: {
        Row: {
          attempts: number
          body: string
          created_at: string
          delivered_at: string | null
          direction: string
          from_ref: string
          id: string
          in_reply_to: string | null
          kind: string
          message_group_id: string | null
          nudge_id: string | null
          read_at: string | null
          serve_count: number
          status: string
          technician_id: string | null
          tenant_id: string
          tier: string | null
          to_ref: string
          updated_at: string
          via: string
        }
        Insert: {
          attempts?: number
          body: string
          created_at?: string
          delivered_at?: string | null
          direction: string
          from_ref: string
          id?: string
          in_reply_to?: string | null
          kind: string
          message_group_id?: string | null
          nudge_id?: string | null
          read_at?: string | null
          serve_count?: number
          status?: string
          technician_id?: string | null
          tenant_id: string
          tier?: string | null
          to_ref: string
          updated_at?: string
          via?: string
        }
        Update: {
          attempts?: number
          body?: string
          created_at?: string
          delivered_at?: string | null
          direction?: string
          from_ref?: string
          id?: string
          in_reply_to?: string | null
          kind?: string
          message_group_id?: string | null
          nudge_id?: string | null
          read_at?: string | null
          serve_count?: number
          status?: string
          technician_id?: string | null
          tenant_id?: string
          tier?: string | null
          to_ref?: string
          updated_at?: string
          via?: string
        }
        Relationships: [
          {
            foreignKeyName: "office_messages_in_reply_to_fkey"
            columns: ["in_reply_to"]
            isOneToOne: false
            referencedRelation: "office_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "office_messages_in_reply_to_fkey"
            columns: ["in_reply_to"]
            isOneToOne: false
            referencedRelation: "v_office_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "office_messages_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "office_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_events: {
        Row: {
          closed_at: string | null
          detail: Json
          host_id: string
          id: string
          opened_at: string
          resolved_detail: Json | null
          service: string
        }
        Insert: {
          closed_at?: string | null
          detail?: Json
          host_id: string
          id?: string
          opened_at?: string
          resolved_detail?: Json | null
          service: string
        }
        Update: {
          closed_at?: string | null
          detail?: Json
          host_id?: string
          id?: string
          opened_at?: string
          resolved_detail?: Json | null
          service?: string
        }
        Relationships: [
          {
            foreignKeyName: "ops_events_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "hosts"
            referencedColumns: ["id"]
          },
        ]
      }
      person_pushes: {
        Row: {
          attempts: number
          body: string
          created_at: string
          delivered_at: string | null
          detail: string | null
          id: string
          kind: string
          serve_count: number
          status: string
          technician_id: string
          tenant_id: string
        }
        Insert: {
          attempts?: number
          body: string
          created_at?: string
          delivered_at?: string | null
          detail?: string | null
          id?: string
          kind: string
          serve_count?: number
          status?: string
          technician_id: string
          tenant_id: string
        }
        Update: {
          attempts?: number
          body?: string
          created_at?: string
          delivered_at?: string | null
          detail?: string | null
          id?: string
          kind?: string
          serve_count?: number
          status?: string
          technician_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_pushes_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_pushes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      planner_memory: {
        Row: {
          content: string
          created_at: string
          path: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          path: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          path?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "planner_memory_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      planner_memory_versions: {
        Row: {
          content: string
          id: string
          path: string
          replaced_at: string
          tenant_id: string
        }
        Insert: {
          content: string
          id?: string
          path: string
          replaced_at?: string
          tenant_id: string
        }
        Update: {
          content?: string
          id?: string
          path?: string
          replaced_at?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "planner_memory_versions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      planner_runs: {
        Row: {
          last_ran_at: string
          last_success_at: string | null
          tenant_id: string
        }
        Insert: {
          last_ran_at: string
          last_success_at?: string | null
          tenant_id: string
        }
        Update: {
          last_ran_at?: string
          last_success_at?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "planner_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      query_audit: {
        Row: {
          created_at: string
          duration_ms: number | null
          error: string | null
          id: string
          row_count: number | null
          sql: string
          technician_ref: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          row_count?: number | null
          sql: string
          technician_ref?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          row_count?: number | null
          sql?: string
          technician_ref?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "query_audit_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_captures: {
        Row: {
          blob_path: string | null
          captured_at: string
          channel: Database["public"]["Enums"]["capture_channel"]
          created_at: string
          customer_id: string | null
          external_id: string | null
          id: string
          job_id: string | null
          metadata: Json
          raw_text: string | null
          retracts_capture_id: string | null
          sensitivity: string | null
          technician_ref: string | null
          tenant_id: string
          visit_id: string | null
        }
        Insert: {
          blob_path?: string | null
          captured_at?: string
          channel: Database["public"]["Enums"]["capture_channel"]
          created_at?: string
          customer_id?: string | null
          external_id?: string | null
          id?: string
          job_id?: string | null
          metadata?: Json
          raw_text?: string | null
          retracts_capture_id?: string | null
          sensitivity?: string | null
          technician_ref?: string | null
          tenant_id: string
          visit_id?: string | null
        }
        Update: {
          blob_path?: string | null
          captured_at?: string
          channel?: Database["public"]["Enums"]["capture_channel"]
          created_at?: string
          customer_id?: string | null
          external_id?: string | null
          id?: string
          job_id?: string | null
          metadata?: Json
          raw_text?: string | null
          retracts_capture_id?: string | null
          sensitivity?: string | null
          technician_ref?: string | null
          tenant_id?: string
          visit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "raw_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "raw_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "raw_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_money_events"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "raw_captures_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "raw_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "raw_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "raw_captures_retracts_capture_id_fkey"
            columns: ["retracts_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_retracts_capture_id_fkey"
            columns: ["retracts_capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_captures_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "raw_captures_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "raw_captures_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      review_items: {
        Row: {
          created_at: string
          detail: Json
          id: string
          kind: string
          resolution: string | null
          resolved_at: string | null
          status: Database["public"]["Enums"]["review_status"]
          subject_ref: string
          suggestion: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          id?: string
          kind: string
          resolution?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["review_status"]
          subject_ref: string
          suggestion?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          detail?: Json
          id?: string
          kind?: string
          resolution?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["review_status"]
          subject_ref?: string
          suggestion?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      roster_events: {
        Row: {
          actor_ref: string | null
          from_state: Database["public"]["Enums"]["technician_state"] | null
          id: string
          occurred_at: string
          reason: string | null
          technician_id: string
          tenant_id: string
          to_state: Database["public"]["Enums"]["technician_state"]
        }
        Insert: {
          actor_ref?: string | null
          from_state?: Database["public"]["Enums"]["technician_state"] | null
          id?: string
          occurred_at?: string
          reason?: string | null
          technician_id: string
          tenant_id: string
          to_state: Database["public"]["Enums"]["technician_state"]
        }
        Update: {
          actor_ref?: string | null
          from_state?: Database["public"]["Enums"]["technician_state"] | null
          id?: string
          occurred_at?: string
          reason?: string | null
          technician_id?: string
          tenant_id?: string
          to_state?: Database["public"]["Enums"]["technician_state"]
        }
        Relationships: [
          {
            foreignKeyName: "roster_events_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sandbox_pool: {
        Row: {
          bot_id: string | null
          bot_username: string | null
          created_at: string
          host_id: string
          id: string
          retire_requested_at: string | null
          retired_at: string | null
          retired_technician_id: string | null
          sandbox_ref: string
          technician_id: string | null
          tenant_id: string
        }
        Insert: {
          bot_id?: string | null
          bot_username?: string | null
          created_at?: string
          host_id: string
          id?: string
          retire_requested_at?: string | null
          retired_at?: string | null
          retired_technician_id?: string | null
          sandbox_ref: string
          technician_id?: string | null
          tenant_id: string
        }
        Update: {
          bot_id?: string | null
          bot_username?: string | null
          created_at?: string
          host_id?: string
          id?: string
          retire_requested_at?: string | null
          retired_at?: string | null
          retired_technician_id?: string | null
          sandbox_ref?: string
          technician_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sandbox_pool_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "hosts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sandbox_pool_retired_technician_id_fkey"
            columns: ["retired_technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sandbox_pool_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: true
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sandbox_pool_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_entries: {
        Row: {
          address_line1: string | null
          attributes: Json
          city: string | null
          created_at: string
          customer_id: string | null
          customer_name: string | null
          external_row_key: string
          id: string
          job_id: string | null
          phone: string | null
          postal_code: string | null
          scheduled_end: string | null
          scheduled_start: string | null
          source: string
          state: string | null
          technician_ref: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          attributes?: Json
          city?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          external_row_key: string
          id?: string
          job_id?: string | null
          phone?: string | null
          postal_code?: string | null
          scheduled_end?: string | null
          scheduled_start?: string | null
          source?: string
          state?: string | null
          technician_ref: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          attributes?: Json
          city?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          external_row_key?: string
          id?: string
          job_id?: string | null
          phone?: string | null
          postal_code?: string | null
          scheduled_end?: string | null
          scheduled_start?: string | null
          source?: string
          state?: string | null
          technician_ref?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_entries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_entries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "schedule_entries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_entries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "schedule_entries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_money_events"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "schedule_entries_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "schedule_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "schedule_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "schedule_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_events: {
        Row: {
          actor_ref: string | null
          assignment_id: string | null
          created_at: string
          detail: Json
          id: number
          kind: string
          tenant_id: string
        }
        Insert: {
          actor_ref?: string | null
          assignment_id?: string | null
          created_at?: string
          detail?: Json
          id?: never
          kind: string
          tenant_id: string
        }
        Update: {
          actor_ref?: string | null
          assignment_id?: string | null
          created_at?: string
          detail?: Json
          id?: never
          kind?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_events_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "schedule_events_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "schedule_events_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      technician_time_off: {
        Row: {
          created_at: string
          ends_on: string
          id: string
          reason: string | null
          starts_on: string
          technician_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          ends_on: string
          id?: string
          reason?: string | null
          starts_on: string
          technician_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          ends_on?: string
          id?: string
          reason?: string | null
          starts_on?: string
          technician_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "technician_time_off_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "technician_time_off_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      technician_view_rules: {
        Row: {
          created_at: string
          hidden_tags: string[] | null
          job_scope: string | null
          money: string | null
          set_by: string | null
          technician_channels:
            | Database["public"]["Enums"]["capture_channel"][]
            | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          hidden_tags?: string[] | null
          job_scope?: string | null
          money?: string | null
          set_by?: string | null
          technician_channels?:
            | Database["public"]["Enums"]["capture_channel"][]
            | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          hidden_tags?: string[] | null
          job_scope?: string | null
          money?: string | null
          set_by?: string | null
          technician_channels?:
            | Database["public"]["Enums"]["capture_channel"][]
            | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "technician_view_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      technicians: {
        Row: {
          availability: Json | null
          badge_hash: string | null
          composio_connected_account_id: string | null
          composio_session_id: string | null
          composio_trigger_id: string | null
          connected_email: string | null
          created_at: string
          display_name: string
          host_id: string | null
          id: string
          link_issued_at: string | null
          offboarding_started_at: string | null
          ref: string
          sandbox_ref: string | null
          seat_exempt: boolean
          service_cities: string[]
          skills: string[]
          state: Database["public"]["Enums"]["technician_state"]
          telegram_user_id: string | null
          tenant_id: string
          tier: Database["public"]["Enums"]["technician_tier"]
          updated_at: string
        }
        Insert: {
          availability?: Json | null
          badge_hash?: string | null
          composio_connected_account_id?: string | null
          composio_session_id?: string | null
          composio_trigger_id?: string | null
          connected_email?: string | null
          created_at?: string
          display_name: string
          host_id?: string | null
          id?: string
          link_issued_at?: string | null
          offboarding_started_at?: string | null
          ref: string
          sandbox_ref?: string | null
          seat_exempt?: boolean
          service_cities?: string[]
          skills?: string[]
          state?: Database["public"]["Enums"]["technician_state"]
          telegram_user_id?: string | null
          tenant_id: string
          tier?: Database["public"]["Enums"]["technician_tier"]
          updated_at?: string
        }
        Update: {
          availability?: Json | null
          badge_hash?: string | null
          composio_connected_account_id?: string | null
          composio_session_id?: string | null
          composio_trigger_id?: string | null
          connected_email?: string | null
          created_at?: string
          display_name?: string
          host_id?: string | null
          id?: string
          link_issued_at?: string | null
          offboarding_started_at?: string | null
          ref?: string
          sandbox_ref?: string | null
          seat_exempt?: boolean
          service_cities?: string[]
          skills?: string[]
          state?: Database["public"]["Enums"]["technician_state"]
          telegram_user_id?: string | null
          tenant_id?: string
          tier?: Database["public"]["Enums"]["technician_tier"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "technicians_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "hosts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "technicians_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_profiles: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          created_at: string
          disclosure_footer: string | null
          display_name: string | null
          email: string | null
          legal_name: string | null
          license_numbers: Json
          phone: string | null
          postal_code: string | null
          state: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          created_at?: string
          disclosure_footer?: string | null
          display_name?: string | null
          email?: string | null
          legal_name?: string | null
          license_numbers?: Json
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          created_at?: string
          disclosure_footer?: string | null
          display_name?: string | null
          email?: string | null
          legal_name?: string | null
          license_numbers?: Json
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_settings: {
        Row: {
          approx_work_end_hour: number | null
          approx_work_start_hour: number | null
          created_at: string
          lookback_hours: number | null
          max_new_per_tick: number | null
          overdue_hours: number | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          approx_work_end_hour?: number | null
          approx_work_start_hour?: number | null
          created_at?: string
          lookback_hours?: number | null
          max_new_per_tick?: number | null
          overdue_hours?: number | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          approx_work_end_hour?: number | null
          approx_work_start_hour?: number | null
          created_at?: string
          lookback_hours?: number | null
          max_new_per_tick?: number | null
          overdue_hours?: number | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          default_job_minutes: number
          id: string
          manager_seats: number
          name: string
          technician_horizon_days: number
          technician_seats: number
          timezone: string
        }
        Insert: {
          created_at?: string
          default_job_minutes?: number
          id?: string
          manager_seats?: number
          name: string
          technician_horizon_days?: number
          technician_seats?: number
          timezone?: string
        }
        Update: {
          created_at?: string
          default_job_minutes?: number
          id?: string
          manager_seats?: number
          name?: string
          technician_horizon_days?: number
          technician_seats?: number
          timezone?: string
        }
        Relationships: []
      }
      visit_notes: {
        Row: {
          capture_id: string
          created_at: string
          tenant_id: string
          visit_id: string
        }
        Insert: {
          capture_id: string
          created_at?: string
          tenant_id: string
          visit_id: string
        }
        Update: {
          capture_id?: string
          created_at?: string
          tenant_id?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visit_notes_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visit_notes_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visit_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visit_notes_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "visit_notes_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "visit_notes_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      visit_participants: {
        Row: {
          created_at: string
          ends_at: string | null
          id: string
          starts_at: string | null
          status: Database["public"]["Enums"]["visit_status"]
          technician_id: string
          tenant_id: string
          visit_id: string
        }
        Insert: {
          created_at?: string
          ends_at?: string | null
          id?: string
          starts_at?: string | null
          status?: Database["public"]["Enums"]["visit_status"]
          technician_id: string
          tenant_id: string
          visit_id: string
        }
        Update: {
          created_at?: string
          ends_at?: string | null
          id?: string
          starts_at?: string | null
          status?: Database["public"]["Enums"]["visit_status"]
          technician_id?: string
          tenant_id?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visit_participants_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visit_participants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visit_participants_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "visit_participants_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "visit_participants_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      visits: {
        Row: {
          attributes: Json
          completed_at: string | null
          created_at: string
          ends_at: string | null
          id: string
          job_id: string
          labor_hours: number | null
          reason: string | null
          source_capture_id: string | null
          started_at: string | null
          starts_at: string | null
          status: Database["public"]["Enums"]["visit_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attributes?: Json
          completed_at?: string | null
          created_at?: string
          ends_at?: string | null
          id?: string
          job_id: string
          labor_hours?: number | null
          reason?: string | null
          source_capture_id?: string | null
          started_at?: string | null
          starts_at?: string | null
          status?: Database["public"]["Enums"]["visit_status"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attributes?: Json
          completed_at?: string | null
          created_at?: string
          ends_at?: string | null
          id?: string
          job_id?: string
          labor_hours?: number | null
          reason?: string | null
          source_capture_id?: string | null
          started_at?: string | null
          starts_at?: string | null
          status?: Database["public"]["Enums"]["visit_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "visits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "visits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "visits_source_capture_id_fkey"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_source_capture_id_fkey"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "v_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      web_requests: {
        Row: {
          created_at: string
          id: string
          kind: string
          technician_ref: string
          tenant_id: string
          value: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          technician_ref: string
          tenant_id: string
          value: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          technician_ref?: string
          tenant_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "web_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_heartbeats: {
        Row: {
          beat_at: string
          detail: Json
          last_ok_at: string | null
          service: string
          work_at: string | null
        }
        Insert: {
          beat_at?: string
          detail?: Json
          last_ok_at?: string | null
          service: string
          work_at?: string | null
        }
        Update: {
          beat_at?: string
          detail?: Json
          last_ok_at?: string | null
          service?: string
          work_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      capture_membership: {
        Row: {
          capture_id: string | null
          customer_id: string | null
          job_id: string | null
          tenant_id: string | null
          via: string | null
          visit_id: string | null
        }
        Relationships: []
      }
      mv_escalation_fates: {
        Row: {
          by_planner: boolean | null
          escalated_at: string | null
          fate: string | null
          handoff_kind: string | null
          item_id: string | null
          item_resolved_at: string | null
          kind: string | null
          late: boolean | null
          nudge_id: string | null
          premature: boolean | null
          resolution: string | null
          tenant_id: string | null
          working_hours_to_fate: number | null
        }
        Relationships: [
          {
            foreignKeyName: "nudges_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      mv_extend_effectiveness: {
        Row: {
          answered_in_time: boolean | null
          extended_at: string | null
          extended_to: string | null
          nudge_id: string | null
          pending: boolean | null
          resolved_at: string | null
          status: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nudge_decisions_nudge_id_fkey"
            columns: ["nudge_id"]
            isOneToOne: false
            referencedRelation: "mv_escalation_fates"
            referencedColumns: ["nudge_id"]
          },
          {
            foreignKeyName: "nudge_decisions_nudge_id_fkey"
            columns: ["nudge_id"]
            isOneToOne: false
            referencedRelation: "mv_gap_outcomes"
            referencedColumns: ["nudge_id"]
          },
          {
            foreignKeyName: "nudge_decisions_nudge_id_fkey"
            columns: ["nudge_id"]
            isOneToOne: false
            referencedRelation: "nudges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudge_decisions_nudge_id_fkey"
            columns: ["nudge_id"]
            isOneToOne: false
            referencedRelation: "v_nudges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nudge_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      mv_gap_outcomes: {
        Row: {
          asked_at: string | null
          closed_by_technician: boolean | null
          kind: string | null
          nudge_id: string | null
          outcome_bucket: string | null
          resolution: string | null
          resolved_at: string | null
          status: string | null
          tenant_id: string | null
          working_hours_open: number | null
        }
        Relationships: [
          {
            foreignKeyName: "nudges_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      mv_whiplash: {
        Row: {
          action: string | null
          decided_at: string | null
          hours_between: number | null
          job_id: string | null
          nudge_id: string | null
          prev_action: string | null
          prev_at: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nudge_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      priced_cost_events_daily: {
        Row: {
          cost_usd: number | null
          day: string | null
          lane: string | null
          method: string | null
          provider: string | null
          quantity: number | null
          sku: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      unpriced_cost_events_daily: {
        Row: {
          day: string | null
          events: number | null
          lane: string | null
          method: string | null
          provider: string | null
          quantity: number | null
          sku: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_cancelled_visits: {
        Row: {
          city: string | null
          customer_id: string | null
          customer_name: string | null
          ends_at: string | null
          job_id: string | null
          job_title: string | null
          job_type: string | null
          local_day: string | null
          local_weekday: string | null
          postal_code: string | null
          reason: string | null
          starts_at: string | null
          technician_names: string[] | null
          technician_refs: string[] | null
          updated_at: string | null
          visit_id: string | null
        }
        Relationships: []
      }
      v_capture_links: {
        Row: {
          capture_id: string | null
          customer_id: string | null
          job_id: string | null
          via: string | null
          visit_id: string | null
        }
        Relationships: []
      }
      v_captures: {
        Row: {
          captured_at: string | null
          channel: Database["public"]["Enums"]["capture_channel"] | null
          id: string | null
          raw_text: string | null
          sensitivity: string | null
          technician_ref: string | null
        }
        Insert: {
          captured_at?: string | null
          channel?: Database["public"]["Enums"]["capture_channel"] | null
          id?: string | null
          raw_text?: string | null
          sensitivity?: string | null
          technician_ref?: string | null
        }
        Update: {
          captured_at?: string | null
          channel?: Database["public"]["Enums"]["capture_channel"] | null
          id?: string | null
          raw_text?: string | null
          sensitivity?: string | null
          technician_ref?: string | null
        }
        Relationships: []
      }
      v_customers: {
        Row: {
          address_line1: string | null
          city: string | null
          created_at: string | null
          email: string | null
          id: string | null
          name: string | null
          phone: string | null
          phone_key: string | null
          postal_code: string | null
          state: string | null
        }
        Insert: {
          address_line1?: string | null
          city?: string | null
          created_at?: string | null
          email?: string | null
          id?: string | null
          name?: string | null
          phone?: string | null
          phone_key?: string | null
          postal_code?: string | null
          state?: string | null
        }
        Update: {
          address_line1?: string | null
          city?: string | null
          created_at?: string | null
          email?: string | null
          id?: string | null
          name?: string | null
          phone?: string | null
          phone_key?: string | null
          postal_code?: string | null
          state?: string | null
        }
        Relationships: []
      }
      v_firm_profile: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          disclosure_footer: string | null
          display_name: string | null
          email: string | null
          legal_name: string | null
          license_numbers: Json | null
          phone: string | null
          postal_code: string | null
          state: string | null
          updated_at: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          disclosure_footer?: string | null
          display_name?: string | null
          email?: string | null
          legal_name?: string | null
          license_numbers?: Json | null
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          updated_at?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          disclosure_footer?: string | null
          display_name?: string | null
          email?: string | null
          legal_name?: string | null
          license_numbers?: Json | null
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      v_jobs: {
        Row: {
          created_at: string | null
          customer_id: string | null
          customer_name: string | null
          duration_minutes: number | null
          id: string | null
          job_type: string | null
          price_cents: number | null
          priority: Database["public"]["Enums"]["job_priority"] | null
          status: Database["public"]["Enums"]["job_status"] | null
          title: string | null
          updated_at: string | null
        }
        Relationships: []
      }
      v_money_events: {
        Row: {
          actor_ref: string | null
          amount_cents: number | null
          corrects_event_id: number | null
          currency: string | null
          customer_id: string | null
          customer_name: string | null
          external_ref: string | null
          id: number | null
          job_id: string | null
          job_title: string | null
          kind: Database["public"]["Enums"]["money_event_kind"] | null
          method: string | null
          occurred_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "money_events_corrects_event_id_fkey"
            columns: ["corrects_event_id"]
            isOneToOne: false
            referencedRelation: "money_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_corrects_event_id_fkey"
            columns: ["corrects_event_id"]
            isOneToOne: false
            referencedRelation: "v_money_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "money_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
        ]
      }
      v_nudges: {
        Row: {
          answered_by_capture_id: string | null
          asked_at: string | null
          attempts: number | null
          created_at: string | null
          escalate_after: string | null
          id: string | null
          job_id: string | null
          kind: string | null
          not_before: string | null
          question: string | null
          queued_at: string | null
          resolution: string | null
          resolved_at: string | null
          serve_count: number | null
          status: string | null
          subject_ref: string | null
          technician_name: string | null
          technician_ref: string | null
        }
        Relationships: []
      }
      v_observations: {
        Row: {
          author: string | null
          dismiss_reason: string | null
          dismissed_at: string | null
          id: string | null
          job_id: string | null
          kind: string | null
          not_before: string | null
          noticed_at: string | null
          status: string | null
          subject_ref: string | null
          technician_name: string | null
          technician_ref: string | null
        }
        Relationships: []
      }
      v_office_messages: {
        Row: {
          body: string | null
          created_at: string | null
          delivered_at: string | null
          direction: string | null
          from_ref: string | null
          id: string | null
          in_reply_to: string | null
          kind: string | null
          nudge_id: string | null
          read_at: string | null
          status: string | null
          tier: string | null
          to_ref: string | null
          via: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string | null
          delivered_at?: string | null
          direction?: string | null
          from_ref?: string | null
          id?: string | null
          in_reply_to?: string | null
          kind?: string | null
          nudge_id?: string | null
          read_at?: string | null
          status?: string | null
          tier?: string | null
          to_ref?: string | null
          via?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string | null
          delivered_at?: string | null
          direction?: string | null
          from_ref?: string | null
          id?: string | null
          in_reply_to?: string | null
          kind?: string | null
          nudge_id?: string | null
          read_at?: string | null
          status?: string | null
          tier?: string | null
          to_ref?: string | null
          via?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "office_messages_in_reply_to_fkey"
            columns: ["in_reply_to"]
            isOneToOne: false
            referencedRelation: "office_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "office_messages_in_reply_to_fkey"
            columns: ["in_reply_to"]
            isOneToOne: false
            referencedRelation: "v_office_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      v_review_items: {
        Row: {
          created_at: string | null
          escalated_from_nudge: string | null
          id: string | null
          job_id: string | null
          kind: string | null
          resolution: string | null
          resolved_at: string | null
          status: Database["public"]["Enums"]["review_status"] | null
          subject_ref: string | null
          suggestion: string | null
          technician_ref: string | null
        }
        Insert: {
          created_at?: string | null
          escalated_from_nudge?: never
          id?: string | null
          job_id?: never
          kind?: string | null
          resolution?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["review_status"] | null
          subject_ref?: string | null
          suggestion?: string | null
          technician_ref?: never
        }
        Update: {
          created_at?: string | null
          escalated_from_nudge?: never
          id?: string | null
          job_id?: never
          kind?: string | null
          resolution?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["review_status"] | null
          subject_ref?: string | null
          suggestion?: string | null
          technician_ref?: never
        }
        Relationships: []
      }
      v_roster_events: {
        Row: {
          from_state: Database["public"]["Enums"]["technician_state"] | null
          id: string | null
          occurred_at: string | null
          technician_name: string | null
          technician_ref: string | null
          tier: Database["public"]["Enums"]["technician_tier"] | null
          to_state: Database["public"]["Enums"]["technician_state"] | null
        }
        Relationships: []
      }
      v_schedule: {
        Row: {
          city: string | null
          completed_at: string | null
          customer_id: string | null
          customer_name: string | null
          ends_at: string | null
          job_id: string | null
          job_status: Database["public"]["Enums"]["job_status"] | null
          job_title: string | null
          job_type: string | null
          local_day: string | null
          local_weekday: string | null
          postal_code: string | null
          stage: string | null
          starts_at: string | null
          status: Database["public"]["Enums"]["visit_status"] | null
          technician_names: string[] | null
          technician_refs: string[] | null
          visit_id: string | null
        }
        Relationships: []
      }
      v_team: {
        Row: {
          availability: Json | null
          created_at: string | null
          display_name: string | null
          ref: string | null
          seat_exempt: boolean | null
          service_cities: string[] | null
          skills: string[] | null
          state: Database["public"]["Enums"]["technician_state"] | null
          tier: Database["public"]["Enums"]["technician_tier"] | null
        }
        Insert: {
          availability?: Json | null
          created_at?: string | null
          display_name?: string | null
          ref?: string | null
          seat_exempt?: boolean | null
          service_cities?: string[] | null
          skills?: string[] | null
          state?: Database["public"]["Enums"]["technician_state"] | null
          tier?: Database["public"]["Enums"]["technician_tier"] | null
        }
        Update: {
          availability?: Json | null
          created_at?: string | null
          display_name?: string | null
          ref?: string | null
          seat_exempt?: boolean | null
          service_cities?: string[] | null
          skills?: string[] | null
          state?: Database["public"]["Enums"]["technician_state"] | null
          tier?: Database["public"]["Enums"]["technician_tier"] | null
        }
        Relationships: []
      }
      v_time_off: {
        Row: {
          ends_on: string | null
          reason: string | null
          starts_on: string | null
          technician_name: string | null
          technician_ref: string | null
        }
        Relationships: []
      }
      v_visit_participants: {
        Row: {
          created_at: string | null
          job_id: string | null
          starts_at: string | null
          status: Database["public"]["Enums"]["visit_status"] | null
          technician_name: string | null
          technician_ref: string | null
          visit_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "visit_participants_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "visit_participants_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["visit_id"]
          },
          {
            foreignKeyName: "visit_participants_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "visits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
        ]
      }
    }
    Functions: {
      capture_content_open: {
        Args: {
          p_capture: string
          p_channel: Database["public"]["Enums"]["capture_channel"]
          p_sensitivity: string
          p_tier: string
          p_view: Database["public"]["CompositeTypes"]["technician_view"]
        }
        Returns: boolean
      }
      capture_full: {
        Args: {
          p_caller_tier: string
          p_capture: string
          p_include_retracted?: boolean
          p_tenant: string
          p_terminal_statuses?: string[]
          p_viewer?: string
        }
        Returns: Json
      }
      capture_in_scope: {
        Args: {
          p_capture: string
          p_tier: string
          p_view: Database["public"]["CompositeTypes"]["technician_view"]
        }
        Returns: boolean
      }
      capture_is_live: { Args: { p_capture: string }; Returns: boolean }
      capture_records: {
        Args: { p_capture_ids: string[]; p_tenant: string }
        Returns: Json
      }
      capture_restricted: {
        Args: {
          p_capture: string
          p_channel: Database["public"]["Enums"]["capture_channel"]
          p_sensitivity: string
          p_tier: string
          p_view: Database["public"]["CompositeTypes"]["technician_view"]
        }
        Returns: boolean
      }
      capture_scope_found: {
        Args: { p_scope: string; p_scope_id: string; p_tenant: string }
        Returns: boolean
      }
      capture_scope_members: {
        Args: { p_scope: string; p_scope_id: string; p_tenant: string }
        Returns: {
          capture_id: string
          via: string[]
        }[]
      }
      capture_visible:
        | {
            Args: {
              p_channel: Database["public"]["Enums"]["capture_channel"]
              p_sensitivity: string
              p_tier: string
            }
            Returns: boolean
          }
        | {
            Args: {
              p_capture: string
              p_channel: Database["public"]["Enums"]["capture_channel"]
              p_sensitivity: string
              p_tier: string
              p_view: Database["public"]["CompositeTypes"]["technician_view"]
            }
            Returns: boolean
          }
      captures_page: {
        Args: {
          p_before_at?: string
          p_before_id?: string
          p_caller_tier: string
          p_include_retracted?: boolean
          p_limit?: number
          p_scope: string
          p_scope_id: string
          p_tenant: string
          p_terminal_statuses?: string[]
          p_text_chars?: number
          p_viewer?: string
        }
        Returns: Json
      }
      claim_next_call: {
        Args: never
        Returns: {
          attempts: number
          audio_delete_after: string | null
          audio_deleted_at: string | null
          audio_ref: string | null
          call_sid: string | null
          caller_phone: string | null
          capture_id: string | null
          consent_announced: boolean
          created_at: string
          external_id: string
          id: string
          last_error: string | null
          legal_hold: boolean
          match_status: string | null
          occurred_at: string | null
          payload: Json
          status: string
          tenant_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "call_ingest"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      customer_contents: {
        Args: {
          p_caller_tier: string
          p_customer: string
          p_recent_jobs?: number
          p_snippet_chars?: number
          p_tenant: string
          p_terminal_statuses?: string[]
          p_viewer?: string
        }
        Returns: Json
      }
      gap_evidence: {
        Args: {
          p_asks: Json
          p_per_gap?: number
          p_tenant: string
          p_text_chars?: number
        }
        Returns: Json
      }
      job_activity_since: {
        Args: { p_job_ids: string[]; p_since: string; p_tenant: string }
        Returns: Json
      }
      query_spine: {
        Args: { p_max_rows?: number; p_sql: string; p_tenant: string }
        Returns: Json
      }
      rollup_costs: {
        Args: { p_period_start: string }
        Returns: {
          rows_written: number
          tenants_touched: number
          unpriced_events: number
        }[]
      }
      search_captures: {
        Args: {
          p_caller_tier: string
          p_limit?: number
          p_query: string
          p_scope: string
          p_scope_id: string
          p_snippet_chars?: number
          p_tenant: string
          p_terminal_statuses?: string[]
          p_viewer?: string
        }
        Returns: Json
      }
      technician_view_of: {
        Args: {
          p_technician: string
          p_tenant: string
          p_terminal_statuses: string[]
        }
        Returns: Database["public"]["CompositeTypes"]["technician_view"]
        SetofOptions: {
          from: "*"
          to: "technician_view"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      tenant_cost_detail: {
        Args: { p_period_start: string; p_tenant_id: string }
        Returns: {
          cost_usd: number
          events: number
          provider: string
          quantity: number
          sku: string
          unit: string
        }[]
      }
      view_has_customer: {
        Args: {
          p_customer: string
          p_view: Database["public"]["CompositeTypes"]["technician_view"]
        }
        Returns: boolean
      }
      view_has_job: {
        Args: {
          p_job: string
          p_view: Database["public"]["CompositeTypes"]["technician_view"]
        }
        Returns: boolean
      }
      view_money_open: {
        Args: {
          p_customer: string
          p_job: string
          p_view: Database["public"]["CompositeTypes"]["technician_view"]
        }
        Returns: boolean
      }
      working_hours_between: {
        Args: { from_ts: string; to_ts: string; tz: string }
        Returns: number
      }
    }
    Enums: {
      capture_channel:
        | "technician_voice"
        | "technician_photo"
        | "technician_note"
        | "phone_call"
        | "web_form"
        | "sms"
        | "email"
        | "chat"
        | "manager_assistant"
        | "manual_correction"
        | "sales_note"
        | "quote"
        | "crm_import"
        | "accounting_event"
        | "iot"
        | "outbound_email"
        | "agent_action"
        | "retraction"
      job_priority: "emergency" | "urgent" | "routine" | "maintenance"
      job_status:
        | "open"
        | "in_progress"
        | "completed"
        | "invoiced"
        | "paid"
        | "cancelled"
        | "declined"
      money_event_kind:
        | "fee_charged"
        | "estimate_presented"
        | "estimate_approved"
        | "estimate_declined"
        | "change_order"
        | "invoice_issued"
        | "invoice_voided"
        | "payment_received"
        | "payment_refunded"
        | "credit_applied"
        | "write_off"
        | "correction"
        | "material_cost"
      review_status: "open" | "resolved" | "dismissed"
      technician_state:
        | "invited"
        | "pending_verification"
        | "active"
        | "offboarding"
        | "offboarded"
      technician_tier: "manager" | "technician"
      visit_status: "proposed" | "confirmed" | "cancelled" | "completed"
    }
    CompositeTypes: {
      technician_view: {
        tenant_id: string | null
        all_scope: boolean | null
        job_ids: string[] | null
        customer_ids: string[] | null
        notes_job_ids: string[] | null
        notes_customer_ids: string[] | null
        channels: Database["public"]["Enums"]["capture_channel"][] | null
        hidden_tags: string[] | null
        technician_ref: string | null
        money_all: boolean | null
        money_job_ids: string[] | null
        money_customer_ids: string[] | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      capture_channel: [
        "technician_voice",
        "technician_photo",
        "technician_note",
        "phone_call",
        "web_form",
        "sms",
        "email",
        "chat",
        "manager_assistant",
        "manual_correction",
        "sales_note",
        "quote",
        "crm_import",
        "accounting_event",
        "iot",
        "outbound_email",
        "agent_action",
        "retraction",
      ],
      job_priority: ["emergency", "urgent", "routine", "maintenance"],
      job_status: [
        "open",
        "in_progress",
        "completed",
        "invoiced",
        "paid",
        "cancelled",
        "declined",
      ],
      money_event_kind: [
        "fee_charged",
        "estimate_presented",
        "estimate_approved",
        "estimate_declined",
        "change_order",
        "invoice_issued",
        "invoice_voided",
        "payment_received",
        "payment_refunded",
        "credit_applied",
        "write_off",
        "correction",
        "material_cost",
      ],
      review_status: ["open", "resolved", "dismissed"],
      technician_state: [
        "invited",
        "pending_verification",
        "active",
        "offboarding",
        "offboarded",
      ],
      technician_tier: ["manager", "technician"],
      visit_status: ["proposed", "confirmed", "cancelled", "completed"],
    },
  },
} as const

