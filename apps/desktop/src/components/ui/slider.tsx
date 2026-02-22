"use client";

import * as React from "react";
import { cn } from "../../lib/utils";

type SliderProps = {
  id?: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number[];
  defaultValue?: number[];
  disabled?: boolean;
  className?: string;
  onValueChange?: (value: number[]) => void;
};

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  (
    {
      id,
      min = 0,
      max = 100,
      step = 1,
      value,
      defaultValue,
      disabled,
      className,
      onValueChange,
    },
    ref,
  ) => {
    const currentValue = React.useMemo(() => {
      if (Array.isArray(value) && value.length > 0) return Number(value[0]);
      if (Array.isArray(defaultValue) && defaultValue.length > 0) {
        return Number(defaultValue[0]);
      }
      return min;
    }, [defaultValue, min, value]);

    return (
      <input
        ref={ref}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={currentValue}
        disabled={disabled}
        onChange={(event) => {
          onValueChange?.([Number(event.target.value)]);
        }}
        className={cn(
          "h-2 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-brand disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      />
    );
  },
);

Slider.displayName = "Slider";

export { Slider };
