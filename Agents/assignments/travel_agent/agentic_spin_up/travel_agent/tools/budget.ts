import { pyRound } from "./util.ts";

export function checkBudget(
  transportPrice: number,
  pricePerNight: number,
  numDays: number,
  numTravellers: number,
  activityCost: number,
  cap: number | null,
  foodCost: number | null = null,
) {
  const nights = Math.max(1, numDays - 1);
  const lodging = pricePerNight * nights;
  const food = foodCost != null && foodCost > 0 ? pyRound(foodCost, 2) : 0;
  const activities = activityCost * numTravellers;
  const total = pyRound(transportPrice + lodging + food + activities, 2);

  return {
    ok: cap == null || total <= cap,
    total,
    cap: cap ?? null,
    overage: cap != null ? pyRound(Math.max(0, total - cap), 2) : 0,
    breakdown: {
      transport: pyRound(transportPrice, 2),
      lodging: pyRound(lodging, 2),
      food: pyRound(food, 2),
      activities: pyRound(activities, 2),
    },
  };
}
