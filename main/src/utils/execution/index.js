import { prisma } from '../prisma/index.js';
import { Prisma } from '@prisma/client';
import { sendNoticesToClient, sendNoticesToAllClients } from '../chartData/chartData.js';

// 전체 유저에게 전송
function sendToAllClient(notices) {
  sendNoticesToAllClients(notices);
}
// 개별 유저에게 전송
function sendToClient(userId, notices) {
  sendNoticesToClient(userId, notices);
}

async function execution(userId, companyId, orderId, type, quantity, price) {
  if (quantity <= 0) return;
  // console.log(userId, companyId, orderId, type, quantity, price);
  let notices = [];
  //기본적으로 주문이 완료되면 [userId:Int, companyId:Int, type:sell or buy, quantity:Int,price:Int ,executed:true] 형태로  notices에 추가
  //주문이 완료되지 않으면 [userId:Int, companyId:Int, type:sell or buy, quantity:Int, price:Int, executed:false] 형태로 notices에 추가
  //주문이 체결이 된다면 문자열로 `${nickname}님의 ${companyName}종목에 대한 ${quantity}주, ${price}원 ${type}주문이 체결되었습니다.`
  //주문이 체결이 안된다면 문자열로 `${nickname}님의 ${companyName}종목에 대한 ${quantity}주, ${price}원 ${type}주문이 체결되지 않았습니다.`
  const company = await prisma.company.findUnique({
    where: {
      companyId,
    },
  });
  try {
    await prisma.$transaction(
      async (tx) => {
        // let startTime = performance.now();
        if (type === 'buy') {
          //매수 주문
          const buyer = await tx.user.findUnique({
            where: {
              userId,
            },
          });
          if (price && buyer.currentMoney < price * quantity) {
            throw new Error('가지고 있는 돈이 부족합니다.');
          }
          // 판매주문들을 모두 조회
          const totalQuantity = await tx.order.groupBy({
            where: {
              companyId: companyId,
              type: 'sell',
            },
            by: ['companyId'], // 또는 필요에 따라 다른 필드로 그룹화
            _sum: {
              quantity: true,
            },
          });
          if (totalQuantity[0]._sum.quantity < quantity) {
            throw new Error(`최대 ${totalQuantity[0]._sum.quantity}주까지만 구매할 수 있습니다.`);
          }
          if (!price) price = 1000000000; //시장가 주문
          let buyerOrder; //사용자 주문
          if (!orderId) {
            buyerOrder = await tx.order.create({
              data: {
                userId,
                companyId,
                type,
                quantity,
                price,
              },
            });
            orderId = buyerOrder.orderId;
          } else {
            buyerOrder = await tx.order.update({
              where: {
                orderId,
              },
              data: {
                userId,
                companyId,
                type,
                quantity,
                price,
              },
            });
          }
          //여기까지 구매 주문 생성 또는 수정 완료
          const sellerOrders = await tx.order.findMany({
            where: {
              companyId,
              type: 'sell',
              price: {
                lte: price,
              },
            },
            orderBy: [
              {
                price: 'asc',
              },
              {
                updatedAt: 'asc',
              },
            ],
          });
          for (let sellerOrder of sellerOrders) {
            const seller = await tx.user.findFirst({
              where: {
                userId: sellerOrder.userId,
              },
            });
            const sellerStock = await tx.stock.findFirst({
              where: {
                userId: sellerOrder.userId,
                companyId,
              },
            });
            if (!sellerStock || sellerStock.quantity < sellerOrder.quantity) {
              //주식이 부족하면 다음 주문으로 넘어감
              await tx.order.delete({
                where: {
                  orderId: sellerOrder.orderId,
                },
              });
              notices.push(`${seller.nickname}님의 ${company.name} 종목에 대한 ${sellerOrder.quantity}주, ${sellerOrder.price}원 판매주문이 체결되지 않았습니다.`);
              continue;
            }
            const buyerStock = await tx.stock.findFirst({
              where: {
                userId,
                companyId,
              },
            });
            if (sellerOrder.quantity < quantity) {
              //판매주문량이 구매주문량보다 적을 때
              //결제되는 양: sellerOrder.quantity
              //결제되는 금액: sellerOrder.price
              // 주식 판매 처리
              await tx.order.delete({
                where: {
                  orderId: sellerOrder.orderId,
                },
              });
              await tx.concluded.create({
                data: {
                  userId: sellerOrder.userId,
                  companyId,
                  type: 'sell',
                  price: sellerOrder.price,
                  quantity: sellerOrder.quantity,
                },
              });
              await tx.user.update({
                where: {
                  userId: sellerOrder.userId,
                },
                data: {
                  currentMoney: {
                    increment: sellerOrder.price * sellerOrder.quantity,
                  },
                },
              });
              if (sellerStock.quantity === sellerOrder.quantity) {
                await tx.stock.delete({
                  where: {
                    stockId: sellerStock.stockId,
                  },
                });
              } else {
                await tx.stock.update({
                  where: {
                    stockId: sellerStock.stockId,
                  },
                  data: {
                    quantity: {
                      decrement: sellerOrder.quantity,
                    },
                    averagePrice: (sellerStock.averagePrice * sellerStock.quantity - sellerOrder.price * sellerOrder.quantity) / (sellerStock.quantity - sellerOrder.quantity),
                  },
                });
              }
              notices.push(`${seller.nickname}님의 ${company.name} 종목에 대한 ${sellerOrder.quantity}주, ${sellerOrder.price}원 판매주문이 체결되었습니다.`);
              //주식 구매 처리
              await tx.order.update({
                where: {
                  orderId,
                },
                data: {
                  quantity: {
                    decrement: sellerOrder.quantity,
                  },
                  updatedAt: buyerOrder.updatedAt,
                },
              });
              await tx.concluded.create({
                data: {
                  userId,
                  companyId,
                  type: 'buy',
                  price: sellerOrder.price,
                  quantity: sellerOrder.quantity,
                },
              });
              buyer.currentMoney -= BigInt(sellerOrder.price) * BigInt(sellerOrder.quantity);
              if (buyer.currentMoney < 0) {
                throw new Error('가지고 있는 돈이 부족합니다.');
              }
              if (buyerStock) {
                await tx.stock.update({
                  where: {
                    stockId: buyerStock.stockId,
                  },
                  data: {
                    quantity: {
                      increment: sellerOrder.quantity,
                    },
                    averagePrice: (buyerStock.averagePrice * buyerStock.quantity + sellerOrder.price * sellerOrder.quantity) / (buyerStock.quantity + sellerOrder.quantity),
                  },
                });
              } else {
                await tx.stock.create({
                  data: {
                    userId,
                    companyId,
                    quantity: sellerOrder.quantity,
                    averagePrice: sellerOrder.price,
                  },
                });
              }
              quantity -= sellerOrder.quantity;
              notices.push(`${buyer.nickname}님의 ${company.name} 종목에 대한 ${sellerOrder.quantity}주, ${sellerOrder.price}원 구매주문이 체결되었습니다.`);
              continue;
            }
            //판매주문량이 구매주문량보다 많거나 같을 때
            //결제되는 양: quantity
            //결제되는 금액: sellerOrder.price
            // 주식 구매 처리
            await tx.order.delete({
              where: {
                orderId,
              },
            });
            await tx.concluded.create({
              data: {
                userId,
                companyId,
                type: 'buy',
                price: sellerOrder.price,
                quantity,
              },
            });
            buyer.currentMoney -= BigInt(sellerOrder.price) * BigInt(quantity);
            if (buyer.currentMoney < 0) {
              throw new Error('가지고 있는 돈이 부족합니다.');
            }
            if (buyerStock) {
              await tx.stock.update({
                where: {
                  stockId: buyerStock.stockId,
                },
                data: {
                  quantity: {
                    increment: quantity,
                  },
                  averagePrice: (buyerStock.averagePrice * buyerStock.quantity + sellerOrder.price * quantity) / (buyerStock.quantity + quantity),
                },
              });
            } else {
              await tx.stock.create({
                data: {
                  userId,
                  companyId,
                  quantity,
                  averagePrice: sellerOrder.price,
                },
              });
            }
            notices.push(`${buyer.nickname}님의 ${company.name} 종목에 대한 ${quantity}주, ${sellerOrder.price}원 구매주문이 체결되었습니다.`);
            // 주식 판매 처리
            if (sellerOrder.quantity === quantity) {
              await tx.order.delete({
                where: {
                  orderId: sellerOrder.orderId,
                },
              });
            } else {
              await tx.order.update({
                where: {
                  orderId: sellerOrder.orderId,
                },
                data: {
                  quantity: {
                    decrement: quantity,
                  },
                  updatedAt: sellerOrder.updatedAt,
                },
              });
            }
            await tx.concluded.create({
              data: {
                userId: sellerOrder.userId,
                companyId,
                type: 'sell',
                price: sellerOrder.price,
                quantity,
              },
            });
            await tx.user.update({
              where: {
                userId: sellerOrder.userId,
              },
              data: {
                currentMoney: {
                  increment: sellerOrder.price * quantity,
                },
              },
            });
            if (sellerStock.quantity === quantity) {
              await tx.stock.delete({
                where: {
                  stockId: sellerStock.stockId,
                },
              });
            } else {
              await tx.stock.update({
                where: {
                  stockId: sellerStock.stockId,
                },
                data: {
                  quantity: {
                    decrement: quantity,
                  },
                  averagePrice: (sellerStock.averagePrice * sellerStock.quantity - sellerOrder.price * quantity) / (sellerStock.quantity - quantity),
                },
              });
            }
            notices.push(`${seller.nickname}님의 ${company.name} 종목에 대한 ${quantity}주, ${sellerOrder.price}원 판매주문이 체결되었습니다.`);
            const currentPrice = sellerOrder.price;
            const lowPrice = Math.min(currentPrice, company.lowPrice);
            const highPrice = Math.max(currentPrice, company.highPrice);
            await tx.company.update({
              where: {
                companyId,
              },
              data: {
                currentPrice,
                lowPrice,
                highPrice,
              },
            });
            await tx.user.update({
              where: {
                userId,
              },
              data: {
                currentMoney: buyer.currentMoney,
              },
            });
            break;
          }
          // let endTime = performance.now();
          // console.log(`Execution time: ${endTime - startTime} ms`);
          console.log('notices', notices);
          // sendToClient(userId, notices);
          sendToAllClient(notices);
          return '요청한 주문이 완료되었습니다.';
          //종결
        } else {
          //매도 주문
          const seller = await tx.user.findUnique({
            where: {
              userId,
            },
          });
          let sellerStock = await tx.stock.findFirst({
            where: {
              userId,
              companyId,
            },
          });
          if (!sellerStock || sellerStock.quantity < quantity) {
            throw new Error('가지고 있는 주식이 부족합니다.');
          }
          // 구매주문들을 모두 조회
          const totalQuantity = await tx.order.groupBy({
            where: {
              companyId: companyId,
              type: 'buy',
            },
            by: ['companyId'], // 또는 필요에 따라 다른 필드로 그룹화
            _sum: {
              quantity: true,
            },
          });
          if (totalQuantity[0]._sum.quantity < quantity) {
            throw new Error(`최대 ${totalQuantity[0]._sum.quantity}주까지만 판매할 수 있습니다.`);
          }
          if (!price) price = 0; //시장가 주문
          let sellerOrder; //사용자 주문
          if (!orderId) {
            sellerOrder = await tx.order.create({
              data: {
                userId,
                companyId,
                type,
                quantity,
                price,
              },
            });
            orderId = sellerOrder.orderId;
          } else {
            sellerOrder = await tx.order.update({
              where: {
                orderId,
              },
              data: {
                userId,
                companyId,
                type,
                quantity,
                price,
              },
            });
          }
          //여기까지 판매 주문 생성 또는 수정 완료
          const buyerOrders = await tx.order.findMany({
            where: {
              companyId,
              type: 'buy',
              price: {
                gte: price,
              },
            },
            orderBy: [
              {
                price: 'desc', // 가격에 대해서는 내림차순 정렬
              },
              {
                updatedAt: 'asc', // 같은 가격을 가진 주문에 대해서는 업데이트 시간 순으로 오름차순 정렬
              },
            ],
          });
          for (let buyerOrder of buyerOrders) {
            const buyer = await tx.user.findFirst({
              where: {
                userId: buyerOrder.userId,
              },
            });
            if (buyer.currentMoney < buyerOrder.price * buyerOrder.quantity) {
              //돈이 부족하면 다음 주문으로 넘어감
              await tx.order.delete({
                where: {
                  orderId: buyerOrder.orderId,
                },
              });
              notices.push(`${buyer.nickname}님의 ${company.name} 종목에 대한 ${buyerOrder.quantity}주, ${buyerOrder.price}원 구매주문이 체결되지 않았습니다.`);
              continue;
            }
            const buyerStock = await tx.stock.findFirst({
              where: {
                userId: buyerOrder.userId,
                companyId,
              },
            });
            sellerStock = await tx.stock.findFirst({
              where: {
                userId,
                companyId,
              },
            });
            if (quantity > buyerOrder.quantity) {
              //판매주문량이 구매주문량보다 많을 때
              //결제되는 양: buyerOrder.quantity
              //결제되는 금액: buyerOrder.price
              // 주식 구매 처리
              await tx.order.delete({
                where: {
                  orderId: buyerOrder.orderId,
                },
              });
              await tx.concluded.create({
                data: {
                  userId: buyerOrder.userId,
                  companyId,
                  type: 'buy',
                  price: buyerOrder.price,
                  quantity: buyerOrder.quantity,
                },
              });
              await tx.user.update({
                where: {
                  userId: buyerOrder.userId,
                },
                data: {
                  currentMoney: {
                    decrement: buyerOrder.price * buyerOrder.quantity,
                  },
                },
              });
              if (buyerStock) {
                await tx.stock.update({
                  where: {
                    stockId: buyerStock.stockId,
                  },
                  data: {
                    quantity: {
                      increment: buyerOrder.quantity,
                    },
                    averagePrice: (buyerStock.averagePrice * buyerStock.quantity + buyerOrder.price * buyerOrder.quantity) / (buyerStock.quantity + buyerOrder.quantity),
                  },
                });
              } else {
                await tx.stock.create({
                  data: {
                    userId: buyerOrder.userId,
                    companyId,
                    quantity: buyerOrder.quantity,
                    averagePrice: buyerOrder.price,
                  },
                });
              }
              notices.push(`${seller.nickname}님의 ${company.name} 종목에 대한 ${buyerOrder.quantity}주, ${buyerOrder.price}원 구매주문이 체결되었습니다.`);
              //주식 판매 처리
              await tx.order.update({
                where: {
                  orderId,
                },
                data: {
                  quantity: {
                    decrement: buyerOrder.quantity,
                  },
                  updatedAt: sellerOrder.updatedAt,
                },
              });
              await tx.concluded.create({
                data: {
                  userId,
                  companyId,
                  type: 'sell',
                  price: buyerOrder.price,
                  quantity: buyerOrder.quantity,
                },
              });
              await tx.user.update({
                where: {
                  userId,
                },
                data: {
                  currentMoney: {
                    increment: buyerOrder.price * buyerOrder.quantity,
                  },
                },
              });
              await tx.stock.update({
                where: {
                  stockId: sellerStock.stockId,
                },
                data: {
                  quantity: {
                    decrement: buyerOrder.quantity,
                  },
                  averagePrice: (sellerStock.averagePrice * sellerStock.quantity - buyerOrder.price * buyerOrder.quantity) / (sellerStock.quantity - buyerOrder.quantity),
                },
              });
              notices.push(`${buyer.nickname}님의 ${company.name} 종목에 대한 ${buyerOrder.quantity}주, ${buyerOrder.price}원 판매주문이 체결되었습니다.`);
              quantity -= buyerOrder.quantity;
              continue;
            }
            //판매주문량이 구매주문량보다 적거나 같을 때
            // 결제되는 양: quantity
            // 결제되는 금액: buyerOrder.price
            // 주식 판매 처리
            await tx.order.delete({
              where: {
                orderId,
              },
            });
            await tx.concluded.create({
              data: {
                userId,
                companyId,
                type: 'sell',
                price: buyerOrder.price,
                quantity,
              },
            });
            await tx.user.update({
              where: {
                userId,
              },
              data: {
                currentMoney: {
                  increment: buyerOrder.price * quantity,
                },
              },
            });
            if (quantity === sellerStock.quantity) {
              await tx.stock.delete({
                where: {
                  stockId: sellerStock.stockId,
                },
              });
            } else {
              await tx.stock.update({
                where: {
                  stockId: sellerStock.stockId,
                },
                data: {
                  quantity: {
                    decrement: quantity,
                  },
                  averagePrice: (sellerStock.averagePrice * sellerStock.quantity - buyerOrder.price * quantity) / (sellerStock.quantity - quantity),
                },
              });
            }
            notices.push(`${seller.nickname}님의 ${company.name} 종목에 대한 ${quantity}주, ${buyerOrder.price}원 판매주문이 체결되었습니다.`);
            // 주식 구매 처리
            if (buyerOrder.quantity === quantity) {
              await tx.order.delete({
                where: {
                  orderId: buyerOrder.orderId,
                },
              });
            } else {
              await tx.order.update({
                where: {
                  orderId: buyerOrder.orderId,
                },
                data: {
                  quantity: {
                    decrement: quantity,
                  },
                  updatedAt: buyerOrder.updatedAt,
                },
              });
            }
            await tx.concluded.create({
              data: {
                userId: buyerOrder.userId,
                companyId,
                type: 'buy',
                price: buyerOrder.price,
                quantity,
              },
            });
            await tx.user.update({
              where: {
                userId: buyerOrder.userId,
              },
              data: {
                currentMoney: {
                  decrement: buyerOrder.price * quantity,
                },
              },
            });
            if (buyerStock) {
              await tx.stock.update({
                where: {
                  stockId: buyerStock.stockId,
                },
                data: {
                  quantity: {
                    increment: quantity,
                  },
                  averagePrice: (buyerStock.averagePrice * buyerStock.quantity + buyerOrder.price * quantity) / (buyerStock.quantity + quantity),
                },
              });
            } else {
              await tx.stock.create({
                data: {
                  userId: buyerOrder.userId,
                  companyId,
                  quantity,
                  averagePrice: buyerOrder.price,
                },
              });
            }
            notices.push(`${buyer.nickname}님의 ${company.name} 종목에 대한 ${quantity}주, ${buyerOrder.price}원 구매주문이 체결되었습니다.`);
            const currentPrice = buyerOrder.price;
            const lowPrice = Math.min(currentPrice, company.lowPrice);
            const highPrice = Math.max(currentPrice, company.highPrice);
            await tx.company.update({
              where: {
                companyId,
              },
              data: {
                currentPrice,
                lowPrice,
                highPrice,
              },
            });

            break;
          }
          // let endTime = performance.now();
          // console.log(`Execution time: ${endTime - startTime} ms`);
          // sendToClient(userId, notices);
          sendToAllClient(notices);
          return '주문이 완료되었습니다.';
          //종결
        }
      },
      {
        maxWait: 5000, // default: 2000
        timeout: 10000, // default: 5000
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      }
    );
    //여기서 notices 배열을 이용하여 채팅창으로 사용자들에게 체결 내역 전달
  } catch (err) {
    throw err;
  }
}

export { execution };
