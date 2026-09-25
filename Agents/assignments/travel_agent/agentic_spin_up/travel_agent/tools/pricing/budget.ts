import { pyRound } from "../util.ts";

// A trip is there and back. Transport prices are for one leg (one person, one way, times the travellers).
// When a return leg was chosen the trip pays both fares; otherwise the outbound fare is counted this many times.
export const TRIP_LEGS = 2;

// What part of the trip is a guess: the part of the transport price that is (each leg may differ), whether the
// stay is, and the estimated meal cost (in the same units as `foodCost`) and activity cost (per person, like `activityCost`).
export interface EstimatedParts {
  transport: number;
  lodging: boolean;
  foodCost: number;
  activityCost: number;
}

const NO_ESTIMATES: EstimatedParts = { transport: 0, lodging: false, foodCost: 0, activityCost: 0 };

export function checkBudget(
  transportPrice: number,
  pricePerNight: number,
  numDays: number,
  numTravellers: number,
  activityCost: number,
  cap: number | null,
  foodCost: number | null = null,
  estimated: EstimatedParts = NO_ESTIMATES,
) {
  const nights = Math.max(1, numDays - 1);
  const lodging = pricePerNight * nights;
  const food = foodCost != null && foodCost > 0 ? pyRound(foodCost, 2) : 0;
  const activities = activityCost * numTravellers;
  const total = pyRound(transportPrice + lodging + food + activities, 2);
  const estimatedTotal = pyRound(
    estimated.transport +
      (estimated.lodging ? lodging : 0) +
      (estimated.foodCost > 0 ? estimated.foodCost : 0) +
      estimated.activityCost * numTravellers,
    2,
  );

  return {
    ok: cap == null || total <= cap,
    total,
    cap: cap ?? null,
    overage: cap != null ? pyRound(Math.max(0, total - cap), 2) : 0,
    estimated_total: estimatedTotal,
    breakdown: {
      transport: pyRound(transportPrice, 2),
      lodging: pyRound(lodging, 2),
      food: pyRound(food, 2),
      activities: pyRound(activities, 2),
    },
  };
}
