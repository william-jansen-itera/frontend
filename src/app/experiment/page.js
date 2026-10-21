"use client";
import { TreeView } from "./module.js";

const data = [
  {
    id: "1",
    name: "Trunk A (3 children)",
    children: [
      {
        id: "2",
        name: "Branch A1 (2 children)",
        children: [
          {
            id: "3",
            name: "Sub A1a (3 children)",
            children: [
              { id: "4", name: "Leaf A1a1" },
              { id: "5", name: "Leaf A1a2" },
              { id: "6", name: "Leaf A1a3" },
            ],
          },
          {
            id: "7",
            name: "Sub A1b (1 child)",
            children: [
              { id: "8", name: "Leaf A1b1" },
            ],
          },
        ],
      },
      {
        id: "9",
        name: "Branch A2 (1 child)",
        children: [
          {
            id: "10",
            name: "Sub A2a (2 children)",
            children: [
              { id: "11", name: "Leaf A2a1" },
              { id: "12", name: "Leaf A2a2" },
            ],
          },
        ],
      },
      {
        id: "13",
        name: "Branch A3 (3 children)",
        children: [
          {
            id: "14",
            name: "Sub A3a (1 child)",
            children: [
              { id: "15", name: "Leaf A3a1" },
            ],
          },
          {
            id: "16",
            name: "Sub A3b (0 children — replaced)",
            children: [
              { id: "17", name: "Leaf A3b1" },
            ],
          },
          {
            id: "18",
            name: "Sub A3c (2 children)",
            children: [
              { id: "19", name: "Leaf A3c1" },
              { id: "20", name: "Leaf A3c2" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "21",
    name: "Trunk B (1 child)",
    children: [
      {
        id: "22",
        name: "Branch B1 (2 children)",
        children: [
          {
            id: "23",
            name: "Sub B1a (3 children)",
            children: [
              { id: "24", name: "Leaf B1a1" },
              { id: "25", name: "Leaf B1a2" },
              { id: "26", name: "Leaf B1a3" },
            ],
          },
          {
            id: "27",
            name: "Sub B1b (1 child)",
            children: [
              { id: "28", name: "Leaf B1b1" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "29",
    name: "Trunk C (2 children)",
    children: [
      {
        id: "30",
        name: "Branch C1 (1 child)",
        children: [
          {
            id: "31",
            name: "Sub C1a (2 children)",
            children: [
              { id: "32", name: "Leaf C1a1" },
              { id: "33", name: "Leaf C1a2" },
            ],
          },
        ],
      },
      {
        id: "34",
        name: "Branch C2 (3 children)",
        children: [
          {
            id: "35",
            name: "Sub C2a (1 child)",
            children: [
              { id: "36", name: "Leaf C2a1" },
            ],
          },
          {
            id: "37",
            name: "Sub C2b (1 child)",
            children: [
              { id: "38", name: "Leaf C2b1" },
            ],
          },
          {
            id: "39",
            name: "Sub C2c (1 child)",
            children: [
              { id: "40", name: "Leaf C2c1" },
            ],
          },
        ],
      },
    ],
  },
];

export default function Experiment() {
  return (
    
      <TreeView data={data} />
   
  );
}

