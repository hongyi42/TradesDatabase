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
      assignments: {
        Row: {
          created_at: string
          earliest_date: string | null
          ends_at: string | null
          id: string
          job_id: string
          latest_date: string | null
          locked: boolean
          promise_level: Database["public"]["Enums"]["promise_level"]
          promised_day: string | null
          reason: string | null
          source_capture_id: string | null
          starts_at: string | null
          status: Database["public"]["Enums"]["assignment_status"]
          technician_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          earliest_date?: string | null
          ends_at?: string | null
          id?: string
          job_id: string
          latest_date?: string | null
          locked?: boolean
          promise_level?: Database["public"]["Enums"]["promise_level"]
          promised_day?: string | null
          reason?: string | null
          source_capture_id?: string | null
          starts_at?: string | null
          status?: Database["public"]["Enums"]["assignment_status"]
          technician_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          earliest_date?: string | null
          ends_at?: string | null
          id?: string
          job_id?: string
          latest_date?: string | null
          locked?: boolean
          promise_level?: Database["public"]["Enums"]["promise_level"]
          promised_day?: string | null
          reason?: string | null
          source_capture_id?: string | null
          starts_at?: string | null
          status?: Database["public"]["Enums"]["assignment_status"]
          technician_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "assignments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["job_id"]
          },
          {
            foreignKeyName: "assignments_source_capture_id_fkey"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "technicians"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_tenant_id_fkey"
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
            foreignKeyName: "jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
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
          nudge_id: string
          outcome: string
          outcome_detail: string | null
          reason: string
          tenant_id: string
        }
        Insert: {
          action: string
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
          nudge_id: string
          outcome: string
          outcome_detail?: string | null
          reason?: string
          tenant_id: string
        }
        Update: {
          action?: string
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
          nudge_id?: string
          outcome?: string
          outcome_detail?: string | null
          reason?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "nudge_decisions_nudge_id_fkey"
            columns: ["nudge_id"]
            isOneToOne: false
            referencedRelation: "nudges"
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
          asked_at: string | null
          attempts: number
          context: Json
          created_at: string
          escalate_after: string | null
          id: string
          kind: string
          not_before: string | null
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
          asked_at?: string | null
          attempts?: number
          context?: Json
          created_at?: string
          escalate_after?: string | null
          id?: string
          kind: string
          not_before?: string | null
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
          asked_at?: string | null
          attempts?: number
          context?: Json
          created_at?: string
          escalate_after?: string | null
          id?: string
          kind?: string
          not_before?: string | null
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
      sandbox_pool: {
        Row: {
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
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_events_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "v_cancelled_visits"
            referencedColumns: ["assignment_id"]
          },
          {
            foreignKeyName: "schedule_events_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "v_schedule"
            referencedColumns: ["assignment_id"]
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
      visits: {
        Row: {
          attributes: Json
          completed_at: string | null
          created_at: string
          id: string
          job_id: string
          labor_hours: number | null
          scheduled_at: string | null
          source_capture_id: string | null
          started_at: string | null
          technician_name: string | null
          tenant_id: string
        }
        Insert: {
          attributes?: Json
          completed_at?: string | null
          created_at?: string
          id?: string
          job_id: string
          labor_hours?: number | null
          scheduled_at?: string | null
          source_capture_id?: string | null
          started_at?: string | null
          technician_name?: string | null
          tenant_id: string
        }
        Update: {
          attributes?: Json
          completed_at?: string | null
          created_at?: string
          id?: string
          job_id?: string
          labor_hours?: number | null
          scheduled_at?: string | null
          source_capture_id?: string | null
          started_at?: string | null
          technician_name?: string | null
          tenant_id?: string
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
            foreignKeyName: "visits_source_capture_fk"
            columns: ["source_capture_id"]
            isOneToOne: false
            referencedRelation: "raw_captures"
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
    }
    Views: {
      v_cancelled_visits: {
        Row: {
          assignment_id: string | null
          city: string | null
          customer_id: string | null
          customer_name: string | null
          earliest_date: string | null
          ends_at: string | null
          job_id: string | null
          job_title: string | null
          job_type: string | null
          latest_date: string | null
          local_day: string | null
          local_weekday: string | null
          postal_code: string | null
          promise_level: Database["public"]["Enums"]["promise_level"] | null
          promised_day: string | null
          reason: string | null
          starts_at: string | null
          technician_name: string | null
          technician_ref: string | null
          updated_at: string | null
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
      v_schedule: {
        Row: {
          assignment_id: string | null
          city: string | null
          customer_id: string | null
          customer_name: string | null
          earliest_date: string | null
          ends_at: string | null
          job_id: string | null
          job_status: Database["public"]["Enums"]["job_status"] | null
          job_title: string | null
          job_type: string | null
          latest_date: string | null
          local_day: string | null
          local_weekday: string | null
          locked: boolean | null
          postal_code: string | null
          promise_level: Database["public"]["Enums"]["promise_level"] | null
          promised_day: string | null
          starts_at: string | null
          status: Database["public"]["Enums"]["assignment_status"] | null
          technician_name: string | null
          technician_ref: string | null
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
    }
    Functions: {
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
    }
    Enums: {
      assignment_status: "proposed" | "confirmed" | "cancelled" | "completed"
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
      promise_level: "none" | "day" | "time" | "time_only"
      review_status: "open" | "resolved" | "dismissed"
      technician_state:
        | "invited"
        | "pending_verification"
        | "active"
        | "offboarding"
        | "offboarded"
      technician_tier: "manager" | "technician"
    }
    CompositeTypes: {
      [_ in never]: never
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
      assignment_status: ["proposed", "confirmed", "cancelled", "completed"],
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
      promise_level: ["none", "day", "time", "time_only"],
      review_status: ["open", "resolved", "dismissed"],
      technician_state: [
        "invited",
        "pending_verification",
        "active",
        "offboarding",
        "offboarded",
      ],
      technician_tier: ["manager", "technician"],
    },
  },
} as const

