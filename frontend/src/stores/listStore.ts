import { create } from 'zustand'
import { api } from '../api/client'
import type { TripSummary } from '../types'

interface ListState {
  trips: TripSummary[]
  loading: boolean
  error: string | null
  fetchTrips: () => Promise<void>
  createTrip: (title?: string) => Promise<string | null>
}

export const useListStore = create<ListState>((set, get) => ({
  trips: [],
  loading: false,
  error: null,
  fetchTrips: async () => {
    set({ loading: true, error: null })
    try {
      const data = await api.trips()
      set({ trips: data.trips, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
  createTrip: async title => {
    try {
      const detail = await api.createTrip(title)
      await get().fetchTrips()
      return detail.trip.tripId
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },
}))
